package backend

import (
	"io/fs"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

// Run opens the native window, serves the UI files, and binds App's methods to JavaScript.
func Run(ui fs.FS) error {
	app := NewApp()

	return wails.Run(&options.App{
		Title:            "irsee",
		Width:            1200,
		Height:           780,
		MinWidth:         720,
		MinHeight:        480,
		AssetServer:      &assetserver.Options{Assets: ui},
		BackgroundColour: &options.RGBA{R: 22, G: 23, B: 26, A: 1},
		OnStartup:        app.startup,
		OnShutdown:       app.shutdown,
		Bind:             []interface{}{app},
	})
}
