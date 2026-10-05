package main

import (
	"os"
	"testing"
	"time"
)

// Manual/integration test: DSLINK_TEST_DISPLAY=:101 go test -run TestInjector
func TestInjector(t *testing.T) {
	d := os.Getenv("DSLINK_TEST_DISPLAY")
	if d == "" {
		t.Skip("no display")
	}
	inj, err := NewInjector(d)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("codes: %v", inj.codes)
	inj.Button("a", true)
	time.Sleep(1500 * time.Millisecond)
	os.WriteFile("/tmp/inj_marker", []byte("held"), 0o644)
	time.Sleep(2500 * time.Millisecond)
	inj.Button("a", false)
}
