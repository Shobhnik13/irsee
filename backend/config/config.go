// Package config loads and saves the user's servers to disk.
package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"irsee/backend/irc"
)

// Config is everything irsee persists.
type Config struct {
	Servers []irc.ServerConfig `json:"servers"`
}

// Load reads config.json; a missing file gives an empty config.
func Load() (Config, error) {
	cfg := Config{Servers: []irc.ServerConfig{}}
	p, err := path()
	if err != nil {
		return cfg, err
	}

	data, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		// Settings saved before the rename to irsee live in the old "Relay" folder.
		data, err = os.ReadFile(filepath.Join(filepath.Dir(filepath.Dir(p)), "Relay", "config.json"))
	}
	if errors.Is(err, os.ErrNotExist) {
		return cfg, nil
	}
	if err != nil {
		return cfg, err
	}

	err = json.Unmarshal(data, &cfg)
	if cfg.Servers == nil {
		cfg.Servers = []irc.ServerConfig{}
	}
	return cfg, err
}

// Save writes config.json atomically with 0600 permissions (it contains passwords).
func Save(cfg Config) error {
	p, err := path()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}

	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// path returns <OS config dir>/irsee/config.json.
func path() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "irsee", "config.json"), nil
}
