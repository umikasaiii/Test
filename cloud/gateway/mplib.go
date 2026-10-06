package main

// Local game library of THIS device: ROMs the user added on this phone/computer. Stored under the gateway work dir (or DSLINK_LIBRARY), never in the repository,
// never uploaded anywhere. The multiplayer UI lists it; the host picks a game from it.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

type LibGame struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	GameCode string `json:"gameCode"` // 4-char cartridge code from the header (selects the Download Play profile); not shown to the user
	Size     int64  `json:"size"`
	Profile  string `json:"profile"` // "mariopartyds" when the Download Play assistant knows the game, else ""
}

func (s *Server) libDir() string {
	d := os.Getenv("DSLINK_LIBRARY")
	if d == "" {
		d = filepath.Join(s.env.WorkDir, "library")
	}
	os.MkdirAll(d, 0o700)
	return d
}

func gameProfile(code string) string {
	if strings.HasPrefix(code, "A8T") { // Mario Party DS (all regions)
		return "mariopartyds"
	}
	return ""
}

func (s *Server) libList() []LibGame {
	out := []LibGame{}
	ents, _ := os.ReadDir(s.libDir())
	for _, e := range ents {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		var g LibGame
		if b, err := os.ReadFile(filepath.Join(s.libDir(), e.Name())); err == nil && json.Unmarshal(b, &g) == nil {
			g.Profile = gameProfile(g.GameCode)
			out = append(out, g)
		}
	}
	return out
}

func (s *Server) libGet(id string) (LibGame, string, bool) {
	for _, g := range s.libList() {
		if g.ID == id {
			return g, filepath.Join(s.libDir(), id+".nds"), true
		}
	}
	return LibGame{}, "", false
}

// POST /api/mp/library (multipart "rom"): validates with dslink_romcheck, stores the file, returns the entry.
func (s *Server) libAdd(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		jsonOut(w, 400, map[string]string{"error": "form non valido"})
		return
	}
	f, _, err := r.FormFile("rom")
	if err != nil {
		jsonOut(w, 400, map[string]string{"error": "manca il file .nds"})
		return
	}
	defer f.Close()
	tmp := filepath.Join(s.libDir(), "incoming.tmp")
	out, err := os.Create(tmp)
	if err != nil {
		jsonOut(w, 500, map[string]string{"error": "salvataggio non riuscito"})
		return
	}
	h := sha256.New()
	n, _ := io.Copy(io.MultiWriter(out, h), io.LimitReader(f, 512<<20))
	out.Close()
	kv := parseKV(func() string { o, _ := run(s.env.RomCheck, tmp); return o }())
	if kv["status"] != "OK" {
		os.Remove(tmp)
		msg := kv["message"]
		if msg == "" {
			msg = "ROM non valida"
		}
		jsonOut(w, 422, map[string]string{"error": msg})
		return
	}
	id := hex.EncodeToString(h.Sum(nil))[:12]
	code := ""
	if b, err := os.ReadFile(tmp); err == nil && len(b) > 0x10 {
		code = string(b[0x0C:0x10])
	}
	g := LibGame{ID: id, Title: kv["title"], GameCode: code, Size: n}
	os.Rename(tmp, filepath.Join(s.libDir(), id+".nds"))
	meta, _ := json.Marshal(g)
	os.WriteFile(filepath.Join(s.libDir(), id+".json"), meta, 0o600)
	g.Profile = gameProfile(code)
	jsonOut(w, 200, g)
}

func (s *Server) libDelete(id string) bool {
	if _, _, ok := s.libGet(id); !ok {
		return false
	}
	os.Remove(filepath.Join(s.libDir(), id+".nds"))
	os.Remove(filepath.Join(s.libDir(), id+".json"))
	return true
}
