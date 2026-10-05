package main

import (
	"fmt"
	"log"
	"sync"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xproto"
	"github.com/jezek/xgb/xtest"
)

// Injector feeds a single emulator's X display with keyboard and absolute-pointer events (XTEST).
// One injector per slot: browser A can only ever reach display A.
type Injector struct {
	mu    sync.Mutex
	c     *xgb.Conn
	root  xproto.Window
	codes map[string]byte
}

// RetroArch's default keyboard binds for the RetroPad -> melonDS DS buttons.
var keysyms = map[string]uint32{
	"up": 0xff52, "down": 0xff54, "left": 0xff51, "right": 0xff53,
	"a": 0x78 /* x */, "b": 0x7a /* z */, "x": 0x73 /* s */, "y": 0x61, /* a */
	"l": 0x71 /* q */, "r": 0x77 /* w */, "start": 0xff0d /* Return */, "select": 0xffe2, /* Shift_R */
}

func NewInjector(display string) (*Injector, error) {
	c, err := xgb.NewConnDisplay(display)
	if err != nil {
		return nil, err
	}
	if err := xtest.Init(c); err != nil {
		return nil, err
	}
	setup := xproto.Setup(c)
	min, max := setup.MinKeycode, setup.MaxKeycode
	km, err := xproto.GetKeyboardMapping(c, min, byte(max-min+1)).Reply()
	if err != nil {
		return nil, err
	}
	per := int(km.KeysymsPerKeycode)
	inj := &Injector{c: c, root: setup.DefaultScreen(c).Root, codes: map[string]byte{}}
	for name, sym := range keysyms {
		for i, ks := range km.Keysyms {
			if uint32(ks) == sym {
				inj.codes[name] = byte(int(min) + i/per)
				break
			}
		}
		if _, ok := inj.codes[name]; !ok {
			return nil, fmt.Errorf("no X keycode for %s", name)
		}
	}
	return inj, nil
}

func (i *Injector) Close() { i.c.Close() }

// Button presses a DS button (up/down/left/right/a/b/x/y/l/r/start/select). Unknown names are ignored.
func (i *Injector) Button(name string, down bool) {
	code, ok := i.codes[name]
	if !ok {
		return
	}
	t := byte(xproto.KeyRelease)
	if down {
		t = byte(xproto.KeyPress)
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	if err := xtest.FakeInputChecked(i.c, t, code, 0, 0, 0, 0, 0).Check(); err != nil {
		log.Printf("xtest key %s: %v", name, err)
	}
}

// Touch moves the pointer over the BOTTOM screen. x,y are normalised (0..1) within that screen; the window is
// exactly screenW x screenH with the touch screen in the lower half.
func (i *Injector) Touch(x, y float64, down bool, move bool) {
	clamp := func(v float64) float64 {
		if v < 0 {
			return 0
		}
		if v > 0.9999 {
			return 0.9999
		}
		return v
	}
	px := int16(clamp(x) * screenW)
	py := int16(screenH/2 + clamp(y)*(screenH/2))
	i.mu.Lock()
	defer i.mu.Unlock()
	xtest.FakeInput(i.c, byte(xproto.MotionNotify), 0, 0, i.root, px, py, 0)
	if !move {
		t := byte(xproto.ButtonRelease)
		if down {
			t = byte(xproto.ButtonPress)
		}
		xtest.FakeInput(i.c, t, 1, 0, i.root, 0, 0, 0)
	}
	i.c.Sync()
}
