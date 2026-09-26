// Package netcount counts bytes sent and received on wrapped connections.
package netcount

import (
	"net"
	"sync/atomic"
)

var in, out atomic.Uint64

type conn struct{ net.Conn }

// Wrap returns c with its traffic added to the global totals.
func Wrap(c net.Conn) net.Conn { return &conn{c} }

// Totals returns bytes received and sent since the app started.
func Totals() (received, sent uint64) { return in.Load(), out.Load() }

// Read counts received bytes.
func (c *conn) Read(b []byte) (int, error) {
	n, err := c.Conn.Read(b)
	in.Add(uint64(n))
	return n, err
}

// Write counts sent bytes.
func (c *conn) Write(b []byte) (int, error) {
	n, err := c.Conn.Write(b)
	out.Add(uint64(n))
	return n, err
}
