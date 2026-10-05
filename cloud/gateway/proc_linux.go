//go:build linux

package main

import (
	"os/exec"
	"sync"
	"syscall"
	"time"
)

func sysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
}

// reaped: processes whose exit is awaited by a dedicated goroutine from the moment they start (no zombies if one is stopped from outside,
// e.g. by the container runtime or an operator); killGroup then waits on that goroutine's channel instead of calling Wait a second time.
var reaped sync.Map

func reap(c *exec.Cmd) {
	ch := make(chan struct{})
	reaped.Store(c, ch)
	go func() { c.Wait(); close(ch) }()
}

func killGroup(c *exec.Cmd) {
	if c.Process == nil {
		return
	}
	syscall.Kill(-c.Process.Pid, syscall.SIGTERM)
	var done chan struct{}
	if v, ok := reaped.Load(c); ok {
		done = v.(chan struct{})
	} else {
		done = make(chan struct{})
		go func() { c.Wait(); close(done) }()
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		syscall.Kill(-c.Process.Pid, syscall.SIGKILL)
	}
}
