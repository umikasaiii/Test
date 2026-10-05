// Download Play / DS wireless diagnostics. Passive: classifies the 802.11 frames that melonDS hands to the netpacket interface
// (outgoing = what this console transmits, incoming = what the bridge delivers) and walks an explicit state machine with timestamps.
// It never alters traffic. Frame layout (melonDS DS libretro core, net/mp.cpp): u64 timestamp BE, u8 aid, u8 type (0 other, 1 reply, 2 cmd),
// then the 12-byte melonDS TX header followed by the 802.11 frame (frame length incl. FCS at header offset 10).
#pragma once
#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace dsrt {

enum class DlState {
    IDLE, RADIO_ON,
    HOST_ADVERTISING,
    CLIENT_SCANNING, GAME_DISCOVERED,
    DOWNLOAD_HANDSHAKE, DOWNLOAD_TRANSFER, DOWNLOAD_VERIFY, CLIENT_GAME_BOOT,
    GAME_HANDSHAKE, LOBBY, IN_GAME,
    ERROR
};
const char* dlStateName(DlState s);

struct DlCounters {
    uint64_t beaconsTx = 0, beaconsRx = 0, nintendoBeaconsTx = 0, nintendoBeaconsRx = 0;
    uint64_t probeReqTx = 0, probeReqRx = 0, probeRespTx = 0, probeRespRx = 0;
    uint64_t authTx = 0, authRx = 0, assocReqTx = 0, assocReqRx = 0, assocRespTx = 0, assocRespRx = 0, deauth = 0;
    uint64_t dataTx = 0, dataRx = 0, dataBytesTx = 0, dataBytesRx = 0, cmd = 0, reply = 0, other = 0;
    uint32_t lastGameId = 0;        // game code from the Nintendo vendor IE of the last beacon (0 = none seen). Not a title; never logged as text.
};

struct DlTransition { double tMs; double prevDurationMs; DlState from, to; std::string reason; };

class DlDiag {
public:
    // pkt = one netpacket payload, tx = true for frames this console sends, nowMs = monotonic milliseconds
    void observe(bool tx, const uint8_t* pkt, size_t len, double nowMs);
    void tick(double nowMs);                 // call about once a second: timeouts and silence detection
    double baseMs() const { return base_ < 0 ? 0 : base_; }
    DlState state() const { return state_; }
    const DlCounters& counters() const { return c_; }
    const std::vector<DlTransition>& history() const { return hist_; }
    std::string json() const;                // {"dl_state":...,"dl_counters":{...},"dl_hist":[...]}
    // optional external annotation (a driver that looked at the screen); recorded like any transition
    static bool parse(const std::string& name, DlState* out);
    void mark(DlState s, const std::string& why, double nowMs) { go(s, why, nowMs); }
    std::function<void(const std::string&)> logFn;

private:
    void go(DlState s, const std::string& why, double nowMs);
    DlState state_ = DlState::IDLE;
    DlCounters c_;
    std::vector<DlTransition> hist_;
    double base_ = -1;                       // times are reported relative to the first call
    double stateSince_ = 0, lastFrame_ = 0, lastBeaconTx_ = 0, lastTransferBytesAt_ = 0, firstSeen_ = -1;
    double handshakeAt_ = 0, cadenceWin_ = 0, lastBulkAt_ = 0;
    uint64_t bulkFrames_ = 0, transferBytes_ = 0, windowCmdReply_ = 0, blankReplies_ = 0, realReplies_ = 0;
    bool associated_ = false, transferDone_ = false;
};

}  // namespace dsrt
