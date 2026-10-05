// devturn: a tiny TURN server (UDP) for LOCAL TESTS ONLY, to exercise the relay-only media path that Cloudflare Containers require
// (no inbound UDP) without Cloudflare. Static long-term credentials. Never shipped in the production image.
//   go run ./cmd/devturn -public-ip 127.0.0.1 -user dslink -pass secret
package main

import (
	"flag"
	"log"
	"net"
	"os"
	"os/signal"
	"strconv"
	"syscall"

	"github.com/pion/turn/v5"
)

func main() {
	ip := flag.String("public-ip", "127.0.0.1", "relay address advertised to clients")
	port := flag.Int("port", 3478, "UDP listen port")
	user := flag.String("user", "dslink", "username")
	pass := flag.String("pass", "dslink-dev", "password")
	realm := flag.String("realm", "dslink-dev", "realm")
	flag.Parse()
	l, err := net.ListenPacket("udp4", net.JoinHostPort("0.0.0.0", strconv.Itoa(*port)))
	if err != nil {
		log.Fatal(err)
	}
	key := turn.GenerateAuthKey(*user, *realm, *pass)
	s, err := turn.NewServer(turn.ServerConfig{
		Realm: *realm,
		AuthHandler: func(ra *turn.RequestAttributes) (string, []byte, bool) {
			if ra.Username == *user {
				return ra.Username, key, true
			}
			return "", nil, false
		},
		PacketConnConfigs: []turn.PacketConnConfig{{PacketConn: l, RelayAddressGenerator: &turn.RelayAddressGeneratorStatic{RelayAddress: net.ParseIP(*ip), Address: "0.0.0.0"}}},
	})
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("devturn listening on udp/%d (relay %s)", *port, *ip)
	c := make(chan os.Signal, 1)
	signal.Notify(c, syscall.SIGINT, syscall.SIGTERM)
	<-c
	s.Close()
}
