// Package irc speaks the IRC protocol: parsing lines and managing one server connection.
package irc

import (
	"errors"
	"strings"
	"time"
	"unicode/utf8"
)

// Message is one parsed IRC line (IRCv3 tags + RFC 1459 prefix/command/params).
type Message struct {
	Tags    map[string]string `json:"tags,omitempty"`
	Nick    string            `json:"nick,omitempty"`
	User    string            `json:"user,omitempty"`
	Host    string            `json:"host,omitempty"`
	Command string            `json:"command"`
	Params  []string          `json:"params"`
	Time    int64             `json:"time"`
}

var errMalformed = errors.New("malformed line")

var tagUnescaper = strings.NewReplacer(`\:`, ";", `\s`, " ", `\\`, `\`, `\r`, "\r", `\n`, "\n")

// ParseMessage splits a raw line into tags, prefix, command, and params.
func ParseMessage(line string) (*Message, error) {
	if !utf8.ValidString(line) {
		line = latin1ToUTF8(line)
	}

	m := &Message{Params: []string{}}

	if strings.HasPrefix(line, "@") {
		tags, rest, ok := strings.Cut(line[1:], " ")
		if !ok {
			return nil, errMalformed
		}
		m.Tags = map[string]string{}
		for _, t := range strings.Split(tags, ";") {
			k, v, _ := strings.Cut(t, "=")
			m.Tags[k] = tagUnescaper.Replace(v)
		}
		line = strings.TrimLeft(rest, " ")
	}

	if strings.HasPrefix(line, ":") {
		prefix, rest, ok := strings.Cut(line[1:], " ")
		if !ok {
			return nil, errMalformed
		}
		m.Nick, m.Host, _ = strings.Cut(prefix, "@")
		m.Nick, m.User, _ = strings.Cut(m.Nick, "!")
		line = strings.TrimLeft(rest, " ")
	}

	cmd, rest, _ := strings.Cut(line, " ")
	if cmd == "" {
		return nil, errMalformed
	}
	m.Command = strings.ToUpper(cmd)

	rest = strings.TrimLeft(rest, " ")
	for rest != "" {
		if rest[0] == ':' {
			m.Params = append(m.Params, rest[1:])
			break
		}
		p, r, _ := strings.Cut(rest, " ")
		m.Params = append(m.Params, p)
		rest = strings.TrimLeft(r, " ")
	}

	m.Time = time.Now().UnixMilli()
	if ts, ok := m.Tags["time"]; ok {
		if t, err := time.Parse(time.RFC3339Nano, ts); err == nil {
			m.Time = t.UnixMilli()
		}
	}

	return m, nil
}

// Param returns param i, or "" if missing.
func (m *Message) Param(i int) string {
	if i < len(m.Params) {
		return m.Params[i]
	}
	return ""
}

// Last returns the final (trailing) param.
func (m *Message) Last() string {
	if len(m.Params) == 0 {
		return ""
	}
	return m.Params[len(m.Params)-1]
}

// latin1ToUTF8 decodes non-UTF-8 lines as Latin-1 so old clients still render.
func latin1ToUTF8(s string) string {
	r := make([]rune, len(s))
	for i := 0; i < len(s); i++ {
		r[i] = rune(s[i])
	}
	return string(r)
}
