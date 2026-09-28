package backend

import (
	"io/fs"
	"runtime"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
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
		Menu:             appMenu(),
		// Wails disables the green zoom/full-screen button when Mac options are nil.
		Mac:        &mac.Options{},
		OnStartup:  app.startup,
		OnShutdown: app.shutdown,
		Bind:       []interface{}{app},
	})
}

// appMenu gives macOS its standard App, Edit and Window menus (Quit, Copy/Paste, Minimize).
// Other platforms get no menu bar.
func appMenu() *menu.Menu {
	if runtime.GOOS != "darwin" {
		return nil
	}
	return menu.NewMenuFromItems(menu.AppMenu(), menu.EditMenu(), menu.WindowMenu())
}
