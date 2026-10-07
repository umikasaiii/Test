package main

// Multiplayer session state machine: ONE source of truth shared by the backend and the UI (/api/mp/state). Illegal transitions are rejected,
// so "impossible" combinations (e.g. IN_GAME without a peer having been connected) cannot be represented by scattered booleans.

import "fmt"

type MpState string

const (
	MpIdle           MpState = "IDLE"
	MpCreatingRoom   MpState = "CREATING_ROOM"
	MpWaitingForPeer MpState = "WAITING_FOR_PEER"
	MpJoining        MpState = "JOINING"
	MpConnected      MpState = "CONNECTED"
	MpNetworkCheck   MpState = "NETWORK_CHECK"
	MpReady          MpState = "READY"
	MpStarting       MpState = "STARTING"
	MpDownloadPlay   MpState = "DOWNLOAD_PLAY"
	MpInGame         MpState = "IN_GAME"
	MpReconnecting   MpState = "RECONNECTING"
	MpEnded          MpState = "ENDED"
	MpError          MpState = "ERROR"
)

var mpAllowed = map[MpState][]MpState{
	MpIdle:           {MpCreatingRoom, MpJoining},
	MpCreatingRoom:   {MpWaitingForPeer, MpError, MpEnded},
	MpWaitingForPeer: {MpConnected, MpNetworkCheck, MpEnded, MpError},
	MpJoining:        {MpConnected, MpError, MpEnded},
	MpConnected:      {MpNetworkCheck, MpReady, MpWaitingForPeer, MpEnded, MpError},
	MpNetworkCheck:   {MpConnected, MpReady, MpWaitingForPeer, MpEnded, MpError},
	MpReady:          {MpStarting, MpConnected, MpNetworkCheck, MpWaitingForPeer, MpEnded, MpError},
	MpStarting:       {MpDownloadPlay, MpInGame, MpError, MpEnded, MpReconnecting},
	MpDownloadPlay:   {MpInGame, MpReconnecting, MpStarting, MpError, MpEnded}, // STARTING again = the setup is redone once, quietly
	MpInGame:         {MpReconnecting, MpEnded, MpConnected, MpWaitingForPeer, MpError},
	MpReconnecting:   {MpInGame, MpDownloadPlay, MpStarting, MpConnected, MpWaitingForPeer, MpEnded, MpError},
	MpEnded:          {MpIdle},
	MpError:          {MpIdle},
}

func mpCanGo(from, to MpState) bool {
	if from == to {
		return true
	}
	for _, s := range mpAllowed[from] {
		if s == to {
			return true
		}
	}
	return false
}

// userMessage turns a machine error code into the sentence the user sees; technical detail stays in the logs / developer mode.
var mpMessages = map[string]string{
	"peer_not_found":   "Non riesco a trovare la partita.",
	"network_isolated": "I dispositivi non riescono a comunicare sulla rete Wi-Fi.",
	"bad_code":         "Codice partita non valido o scaduto.",
	"room_expired":     "Codice partita non valido o scaduto.",
	"room_full":        "La partita è già al completo.",
	"high_latency":     "La rete non è abbastanza veloce per la modalità Distribuita.",
	"peer_left":        "L'altro giocatore si è disconnesso.",
	"peer_lost":        "Connessione con il giocatore persa.",
	"host_closed":      "L'host ha chiuso la partita.",
	"locked":           "Troppi tentativi. Riprova tra qualche istante.",
	"rejected":         "L'host ha rifiutato la richiesta.",
	"no_game":          "Scegli un gioco dalla libreria.",
	"busy":             "Una partita è già in corso su questo dispositivo.",
	"start_failed":     "Non riesco ad avviare la partita.",
	"setup_timeout":    "Non riesco a trovare la partita.",
	"not_ready":        "I giocatori non sono ancora pronti.",
	"no_firmware":      "Mancano i file di sistema Nintendo DS (firmware) su questo dispositivo.",
	"no_refs":          "Per avviare questo gioco servono i riferimenti delle schermate (refs.json): importali in FILE DI SISTEMA.",
	"internal":         "Qualcosa è andato storto. Riprova.",
}

type MpErr struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func mpErr(code string) *MpErr {
	m, ok := mpMessages[code]
	if !ok {
		m = mpMessages["internal"]
	}
	return &MpErr{Code: code, Message: m}
}

func (e *MpErr) Error() string { return fmt.Sprintf("%s: %s", e.Code, e.Message) }
