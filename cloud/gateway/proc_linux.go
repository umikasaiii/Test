//go:build linux

package main

import (
	"os/exec"
	"syscall"
	"time"
)

func sysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
}

func killGroup(c *exec.Cmd) {
	if c.Process == nil {
		return
	}
	syscall.Kill(-c.Process.Pid, syscall.SIGTERM)
	done := make(chan struct{})
	go func() { c.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		syscall.Kill(-c.Process.Pid, syscall.SIGKILL)
	}
}
