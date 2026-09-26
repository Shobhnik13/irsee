// Package stats samples CPU, memory and network use for the status bar.
package stats

import (
	"os"
	goruntime "runtime"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/process"

	"irsee/backend/netcount"
)

// Stats is a resource snapshot for the status bar. Rates are per second since the previous call.
type Stats struct {
	CPU         float64 `json:"cpu"`
	RSS         uint64  `json:"rss"`
	Heap        uint64  `json:"heap"`
	Goroutines  int     `json:"goroutines"`
	SysCPU      float64 `json:"sysCpu"`
	SysMemUsed  uint64  `json:"sysMemUsed"`
	SysMemTotal uint64  `json:"sysMemTotal"`
	NetIn       uint64  `json:"netIn"`
	NetOut      uint64  `json:"netOut"`
	Uptime      int64   `json:"uptime"`
}

// Sampler remembers previous readings so it can report rates.
type Sampler struct {
	mu       sync.Mutex
	started  time.Time
	self     *process.Process
	children map[int32]*process.Process
	lastAt   time.Time
	lastIn   uint64
	lastOut  uint64
}

// New starts a sampler; uptime is measured from this call.
func New() *Sampler {
	return &Sampler{started: time.Now(), children: map[int32]*process.Process{}}
}

// Sample reads current usage; network rates are per second since the previous call.
func (s *Sampler) Sample() Stats {
	s.mu.Lock()
	defer s.mu.Unlock()

	var out Stats
	if s.self == nil {
		s.self, _ = process.NewProcess(int32(os.Getpid()))
	}
	if s.self != nil {
		procs := []*process.Process{s.self}
		// Windows (WebView2) and Linux (WebKitGTK) run the webview as child processes; count them too.
		if kids, err := s.self.Children(); err == nil {
			seen := map[int32]bool{}
			for _, k := range kids {
				seen[k.Pid] = true
				if s.children[k.Pid] == nil {
					s.children[k.Pid] = k
				}
				procs = append(procs, s.children[k.Pid])
			}
			for pid := range s.children {
				if !seen[pid] {
					delete(s.children, pid)
				}
			}
		}
		for _, p := range procs {
			if pct, err := p.Percent(0); err == nil {
				out.CPU += pct
			}
			if mi, err := p.MemoryInfo(); err == nil {
				out.RSS += mi.RSS
			}
		}
	}

	var ms goruntime.MemStats
	goruntime.ReadMemStats(&ms)
	out.Heap = ms.HeapAlloc
	out.Goroutines = goruntime.NumGoroutine()

	if pcts, err := cpu.Percent(0, false); err == nil && len(pcts) > 0 {
		out.SysCPU = pcts[0]
	}
	if vm, err := mem.VirtualMemory(); err == nil {
		out.SysMemUsed, out.SysMemTotal = vm.Used, vm.Total
	}

	now := time.Now()
	in, sent := netcount.Totals()
	if !s.lastAt.IsZero() {
		secs := now.Sub(s.lastAt).Seconds()
		if secs > 0 {
			out.NetIn = uint64(float64(in-s.lastIn) / secs)
			out.NetOut = uint64(float64(sent-s.lastOut) / secs)
		}
	}
	s.lastAt, s.lastIn, s.lastOut = now, in, sent
	out.Uptime = int64(now.Sub(s.started).Seconds())
	return out
}
