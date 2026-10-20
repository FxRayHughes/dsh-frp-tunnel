package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Profile is the connection the phone remembers between launches.
type Profile struct {
	// Server is the public DSH entry, e.g. https://dsh.example.com
	Server string `json:"server"`
	// User and Password are the tunnel gate credentials (tunnelUser / tunnelPassword).
	User     string `json:"user"`
	Password string `json:"password"`
	// AutoConnect skips the settings screen on launch when the profile is complete.
	AutoConnect bool `json:"autoConnect"`
}

// TestResult reports a dry-run login against the relay.
type TestResult struct {
	OK      bool   `json:"ok"`
	Message string `json:"message"`
	// LoginURL is where the WebView should POST the credentials.
	LoginURL string `json:"loginUrl"`
}

// ProfileService stores the profile in the app-private config directory and
// checks credentials before the WebView leaves the bundled settings page.
type ProfileService struct {
	mu sync.Mutex
}

// profilePath resolves an app-private location: Android/iOS internal files
// (no storage permission, removed with the app), else the desktop config dir.
func profilePath() (string, error) {
	dir := application.Mobile.StoragePath()
	if dir == "" {
		base, err := os.UserConfigDir()
		if err != nil || base == "" {
			if base, err = os.UserHomeDir(); err != nil {
				return "", err
			}
		}
		dir = filepath.Join(base, "dsh-mobile")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	return filepath.Join(dir, "profile.json"), nil
}

// Load returns the stored profile, or defaults when none is saved yet.
func (s *ProfileService) Load() Profile {
	s.mu.Lock()
	defer s.mu.Unlock()
	fallback := Profile{Server: "", User: "dsh", AutoConnect: true}
	path, err := profilePath()
	if err != nil {
		return fallback
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return fallback
	}
	var p Profile
	if json.Unmarshal(data, &p) != nil {
		return fallback
	}
	return p
}

// Save normalizes and persists the profile; the file is readable by this app only.
func (s *ProfileService) Save(p Profile) (Profile, error) {
	server, err := normalizeServer(p.Server)
	if err != nil {
		return p, err
	}
	p.Server = server
	p.User = strings.TrimSpace(p.User)
	s.mu.Lock()
	defer s.mu.Unlock()
	path, err := profilePath()
	if err != nil {
		return p, err
	}
	data, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return p, err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return p, err
	}
	return p, os.Rename(tmp, path)
}

// Forget deletes the stored profile.
func (s *ProfileService) Forget() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	path, err := profilePath()
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// Test logs in against the relay without touching the WebView, so a typo shows
// up as a readable message instead of a broken page.
func (s *ProfileService) Test(p Profile) TestResult {
	server, err := normalizeServer(p.Server)
	if err != nil {
		return TestResult{Message: err.Error()}
	}
	loginURL := server + "/__frp/login"

	jar, _ := cookiejar.New(nil)
	client := &http.Client{
		Timeout: 15 * time.Second,
		Jar:     jar,
		// The relay answers JSON for JSON posts; never follow into the DSH page.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	body, _ := json.Marshal(map[string]string{"user": strings.TrimSpace(p.User), "password": p.Password})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, loginURL, strings.NewReader(string(body)))
	if err != nil {
		return TestResult{Message: err.Error()}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return TestResult{Message: "无法连接服务器：" + friendlyNetErr(err)}
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))

	switch res.StatusCode {
	case http.StatusOK:
		var reply struct {
			OK bool `json:"ok"`
		}
		if json.Unmarshal(raw, &reply) == nil && reply.OK {
			return TestResult{OK: true, Message: "连接成功", LoginURL: loginURL}
		}
		return TestResult{Message: "服务器响应异常，请确认地址指向 DSH 隧道"}
	case http.StatusUnauthorized:
		return TestResult{Message: "用户名或密码错误"}
	case http.StatusTooManyRequests:
		return TestResult{Message: "尝试次数过多，请 10 分钟后再试"}
	case http.StatusNotFound:
		return TestResult{Message: "服务器上没有登录入口，插件版本可能过旧"}
	case http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return TestResult{Message: "服务器在线，但电脑端 DSH 未连接（隧道离线）"}
	default:
		return TestResult{Message: fmt.Sprintf("服务器返回 %d", res.StatusCode)}
	}
}

func normalizeServer(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", errors.New("请填写服务器地址")
	}
	if !strings.Contains(value, "://") {
		value = "https://" + value
	}
	u, err := url.Parse(value)
	if err != nil || u.Host == "" {
		return "", errors.New("服务器地址格式不正确")
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return "", errors.New("地址必须以 https:// 或 http:// 开头")
	}
	return u.Scheme + "://" + u.Host, nil
}

func friendlyNetErr(err error) string {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "no such host"):
		return "域名解析失败"
	case strings.Contains(msg, "timeout") || strings.Contains(msg, "deadline"):
		return "连接超时"
	case strings.Contains(msg, "certificate"):
		return "证书校验失败"
	case strings.Contains(msg, "refused"):
		return "连接被拒绝"
	}
	return msg
}
