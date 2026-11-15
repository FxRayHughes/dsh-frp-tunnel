package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/fatedier/frp/client"
	"github.com/fatedier/frp/pkg/config/source"
	v1 "github.com/fatedier/frp/pkg/config/v1"
	frplog "github.com/fatedier/frp/pkg/util/log"
	golog "github.com/fatedier/golib/log"
)

// P2PInfo is what the desktop tunnel plugin hands out at /__frp/p2p after
// login: how to reach frps and which proxies lead to the desktop.
type P2PInfo struct {
	ServerAddr    string `json:"serverAddr"`
	ServerPort    int    `json:"serverPort"`
	TLS           bool   `json:"tls"`
	User          string `json:"user"`
	Token         string `json:"token"`
	Proxy         string `json:"proxy"`
	FallbackProxy string `json:"fallbackProxy"`
	SecretKey     string `json:"secretKey"`
}

// P2PResult tells the page where to send the WebView.
type P2PResult struct {
	OK bool `json:"ok"`
	// LocalURL is the loopback origin of the visitor, e.g. http://127.0.0.1:41234
	LocalURL string `json:"localUrl"`
	// Route is "p2p" when a hole is open, "relay" when frps carries the traffic.
	Route   string `json:"route"`
	Message string `json:"message"`
}

const (
	// How long a connection waits for a hole before frps relays it.
	fallbackMs = 1500
	// First connect: login to frps plus the first punch attempt.
	p2pReadyTimeout = 12 * time.Second
	visitorName     = "dsh-remote"
)

// P2PService runs one embedded frp client with an xtcp visitor (falling back
// to stcp) on a loopback port. The WebView then talks to the desktop through
// it instead of the public URL; the desktop relay and its login stay the same.
type P2PService struct {
	mu      sync.Mutex
	svc     *client.Service
	cancel  context.CancelFunc
	key     string
	port    int
	punched bool
	logOnce sync.Once
}

// logSink scans frp's log for the visitor's punch results.
type logSink struct{ s *P2PService }

func (w logSink) Write(p []byte) (int, error) {
	line := string(p)
	switch {
	case strings.Contains(line, "establishing nat hole connection successful"):
		w.s.setPunched(true)
	case strings.Contains(line, "open tunnel error"), strings.Contains(line, "keepTunnelOpenWorker get tunnel connection error"):
		w.s.setPunched(false)
	}
	return len(p), nil
}

func (s *P2PService) setPunched(v bool) {
	s.mu.Lock()
	s.punched = v
	s.mu.Unlock()
}

// Connect logs in to the public relay, asks it for the P2P settings, and
// starts (or reuses) the visitor. A failure means: use the public URL.
func (s *P2PService) Connect(p Profile) P2PResult {
	server, err := normalizeServer(p.Server)
	if err != nil {
		return P2PResult{Message: err.Error()}
	}
	info, err := fetchP2PInfo(server, strings.TrimSpace(p.User), p.Password)
	if err != nil {
		return P2PResult{Message: err.Error()}
	}
	port, err := s.start(info)
	if err != nil {
		return P2PResult{Message: err.Error()}
	}
	local := "http://127.0.0.1:" + strconv.Itoa(port)
	if err := waitThrough(local, p2pReadyTimeout); err != nil {
		return P2PResult{Message: "P2P 与中转都没有接通：" + err.Error()}
	}
	return P2PResult{OK: true, LocalURL: local, Route: s.Route()}
}

// Route reports whether traffic currently goes through an open hole.
func (s *P2PService) Route() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.punched {
		return "p2p"
	}
	return "relay"
}

// Stop tears the visitor down, e.g. when the user goes back to settings.
func (s *P2PService) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stopLocked()
}

func (s *P2PService) stopLocked() {
	if s.svc != nil {
		s.svc.Close()
		s.cancel()
	}
	s.svc = nil
	s.key = ""
	s.punched = false
}

func (s *P2PService) start(info *P2PInfo) (int, error) {
	raw, _ := json.Marshal(info)
	key := string(raw)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.svc != nil && s.key == key {
		return s.port, nil
	}
	s.stopLocked()
	s.logOnce.Do(func() {
		frplog.Logger = frplog.Logger.WithOptions(golog.WithOutput(logSink{s}), golog.WithLevel(golog.InfoLevel))
	})

	port, err := freePort()
	if err != nil {
		return 0, err
	}
	loginFailExit := false
	common := &v1.ClientCommonConfig{
		ServerAddr:    info.ServerAddr,
		ServerPort:    info.ServerPort,
		User:          info.User,
		LoginFailExit: &loginFailExit,
	}
	common.Transport.TLS.Enable = &info.TLS
	// A STUN server that answered just now; see stun.go.
	if stunServer := pickStunServer(); stunServer != "" {
		common.NatHoleSTUNServer = stunServer
	}
	if info.Token != "" {
		common.Auth.Method = v1.AuthMethodToken
		common.Auth.Token = info.Token
	}
	xtcp := &v1.XTCPVisitorConfig{
		VisitorBaseConfig: v1.VisitorBaseConfig{
			Name:       visitorName,
			Type:       "xtcp",
			Transport:  v1.VisitorTransport{UseEncryption: true},
			SecretKey:  info.SecretKey,
			ServerName: info.Proxy,
			BindAddr:   "127.0.0.1",
			BindPort:   port,
		},
		KeepTunnelOpen:    true,
		FallbackTo:        visitorName + "-s",
		FallbackTimeoutMs: fallbackMs,
	}
	stcp := &v1.STCPVisitorConfig{
		VisitorBaseConfig: v1.VisitorBaseConfig{
			Name:       visitorName + "-s",
			Type:       "stcp",
			Transport:  v1.VisitorTransport{UseEncryption: true},
			SecretKey:  info.SecretKey,
			ServerName: info.FallbackProxy,
			BindPort:   -1,
		},
	}
	cfgSource := source.NewConfigSource()
	if err := cfgSource.ReplaceAll(nil, []v1.VisitorConfigurer{xtcp, stcp}); err != nil {
		return 0, err
	}
	svc, err := client.NewService(client.ServiceOptions{Common: common, ConfigSourceAggregator: source.NewAggregator(cfgSource)})
	if err != nil {
		return 0, fmt.Errorf("frp 客户端初始化失败：%v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() { _ = svc.Run(ctx) }()
	s.svc, s.cancel, s.key, s.port, s.punched = svc, cancel, key, port, false
	return port, nil
}

func fetchP2PInfo(server, user, password string) (*P2PInfo, error) {
	jar, _ := cookiejar.New(nil)
	httpClient := &http.Client{Timeout: 15 * time.Second, Jar: jar}
	req, err := http.NewRequest(http.MethodGet, server+"/__frp/p2p", nil)
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(user, password)
	res, err := httpClient.Do(req)
	if err != nil {
		return nil, errors.New("无法连接服务器：" + friendlyNetErr(err))
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 16<<10))
	switch res.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound:
		return nil, errors.New("电脑端没有开启 P2P（插件版本过旧，或关闭了「手机 App P2P 直连」）")
	case http.StatusUnauthorized:
		return nil, errors.New("用户名或密码错误")
	default:
		return nil, fmt.Errorf("服务器返回 %d", res.StatusCode)
	}
	var info struct {
		OK bool `json:"ok"`
		P2PInfo
	}
	if json.Unmarshal(raw, &info) != nil || !info.OK || info.Proxy == "" || info.ServerAddr == "" {
		return nil, errors.New("服务器的 P2P 设置不完整")
	}
	if info.ServerPort == 0 {
		info.ServerPort = 7000
	}
	if info.FallbackProxy == "" {
		info.FallbackProxy = info.Proxy + "-s"
	}
	return &info.P2PInfo, nil
}

// waitThrough waits until the desktop relay answers through the visitor.
// The login page is static and needs no credentials.
func waitThrough(local string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	httpClient := &http.Client{
		Timeout:       8 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	var last error
	for time.Now().Before(deadline) {
		res, err := httpClient.Get(local + "/__frp/login")
		if err == nil {
			res.Body.Close()
			if res.StatusCode == http.StatusOK {
				return nil
			}
			last = fmt.Errorf("HTTP %d", res.StatusCode)
		} else {
			last = err
		}
		time.Sleep(400 * time.Millisecond)
	}
	if last == nil {
		last = errors.New("超时")
	}
	return last
}

func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}
