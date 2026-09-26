package main

import (
	"embed"
	"io/fs"
	"log"

	"irsee/backend"
)

//go:embed all:frontend
var assets embed.FS

// main embeds the frontend folder into the binary and starts the app.
func main() {
	ui, err := fs.Sub(assets, "frontend")
	if err != nil {
		log.Fatal(err)
	}
	if err := backend.Run(ui); err != nil {
		log.Fatal(err)
	}
}
