package main

import (
	"net"
	"strconv"
	"time"

	"github.com/fatedier/golib/net/stun"
)

// stunCandidates are tried in order. frp's default, stun.easyvoip.com, resolves
// to four addresses of which two stopped answering, so roughly every other
// hole punch aborted and fell back to the frps relay.
var stunCandidates = []string{"stun.miwifi.com:3478", "stun.easyvoip.com:3478", "stun.nextcloud.com:443"}

const stunTimeout = 2500 * time.Millisecond

// stunBinding does one Binding request with frp's own STUN client.
func stunBinding(conn *net.UDPConn, client *stun.Client, server *net.UDPAddr) (*stun.BindingResponse, bool) {
	tx, err := stun.NewBindingTransaction(server)
	if err != nil {
		return nil, false
	}
	if conn.SetReadDeadline(time.Now().Add(stunTimeout)) != nil {
		return nil, false
	}
	resp, err := client.Do(tx)
	if err != nil || resp.MappedAddr == nil {
		return nil, false
	}
	return &resp, true
}

// probeStun mirrors frp's discovery: a Binding request, then one to the
// server's OTHER-ADDRESS when it names one. Both must answer.
func probeStun(server *net.UDPAddr) bool {
	conn, err := net.ListenUDP("udp4", nil)
	if err != nil {
		return false
	}
	defer conn.Close()
	client, err := stun.NewClient(conn)
	if err != nil {
		return false
	}
	first, ok := stunBinding(conn, client, server)
	if !ok {
		return false
	}
	if first.OtherAddr == nil {
		return true
	}
	_, ok = stunBinding(conn, client, first.OtherAddr)
	return ok
}

// pickStunServer returns the first candidate address that passes probeStun as
// a literal ip:port, so frp cannot resolve the name to a dead address itself.
// Empty means none answered and frp keeps its default.
func pickStunServer() string {
	for _, candidate := range stunCandidates {
		host, portText, err := net.SplitHostPort(candidate)
		if err != nil {
			continue
		}
		port, err := strconv.Atoi(portText)
		if err != nil {
			continue
		}
		ips, err := net.LookupIP(host)
		if err != nil {
			continue
		}
		for _, ip := range ips {
			if ip.To4() == nil {
				continue
			}
			addr := &net.UDPAddr{IP: ip, Port: port}
			if probeStun(addr) {
				return addr.String()
			}
		}
	}
	return ""
}
