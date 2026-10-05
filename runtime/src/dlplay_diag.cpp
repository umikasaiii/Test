#include "dlplay_diag.hpp"

#include <cstdio>
#include <sstream>

namespace dsrt {

const char* dlStateName(DlState s) {
    switch (s) {
        case DlState::IDLE: return "IDLE";
        case DlState::RADIO_ON: return "RADIO_ON";
        case DlState::HOST_ADVERTISING: return "HOST_ADVERTISING";
        case DlState::CLIENT_SCANNING: return "CLIENT_SCANNING";
        case DlState::GAME_DISCOVERED: return "GAME_DISCOVERED";
        case DlState::DOWNLOAD_HANDSHAKE: return "DOWNLOAD_HANDSHAKE";
        case DlState::DOWNLOAD_TRANSFER: return "DOWNLOAD_TRANSFER";
        case DlState::DOWNLOAD_VERIFY: return "DOWNLOAD_VERIFY";
        case DlState::CLIENT_GAME_BOOT: return "CLIENT_GAME_BOOT";
        case DlState::GAME_HANDSHAKE: return "GAME_HANDSHAKE";
        case DlState::LOBBY: return "LOBBY";
        case DlState::IN_GAME: return "IN_GAME";
        case DlState::ERROR: return "ERROR";
    }
    return "?";
}

bool DlDiag::parse(const std::string& n, DlState* out) {
    for (int i = 0; i <= int(DlState::ERROR); i++) if (n == dlStateName(DlState(i))) { *out = DlState(i); return true; }
    return false;
}

namespace {
constexpr size_t kPk = 10, kTxHdr = 12, kFrame = kPk + kTxHdr, kMgmtHdr = 24;
constexpr double kTransferQuietMs = 1500, kHandshakeTimeoutMs = 15000, kCadenceMs = 2000;
constexpr uint64_t kInGameCadence = 40;             // cmd/reply frames per 2 s window

// Nintendo's vendor IE (OUI 00:09:BF) inside a beacon: returns true and the first four bytes after the OUI (+type byte) as an id
bool nintendoIe(const uint8_t* ie, size_t n, uint32_t* id) {
    size_t o = 0;
    while (o + 2 <= n) {
        uint8_t t = ie[o], l = ie[o + 1];
        if (o + 2 + l > n) return false;
        if (t == 0xDD && l >= 4 && ie[o + 2] == 0x00 && ie[o + 3] == 0x09 && ie[o + 4] == 0xBF) {
            if (id) { *id = 0; for (size_t i = 0; i < 4 && o + 6 + i < o + 2 + l; i++) *id |= uint32_t(ie[o + 6 + i]) << (8 * i); }
            return true;
        }
        o += 2 + l;
    }
    return false;
}
}  // namespace

void DlDiag::go(DlState s, const std::string& why, double now) {
    if (s == state_) return;
    DlTransition t{now, now - stateSince_, state_, s, why};
    hist_.push_back(t);
    if (hist_.size() > 200) hist_.erase(hist_.begin());
    state_ = s;
    stateSince_ = now;
    if (logFn) {
        char b[256];
        std::snprintf(b, sizeof b, "DLPLAY %s -> %s  t=%.0fms  prev_state_lasted=%.0fms  (%s)", dlStateName(t.from), dlStateName(s), now, t.prevDurationMs, why.c_str());
        logFn(b);
    }
}

void DlDiag::observe(bool tx, const uint8_t* p, size_t n, double now) {
    if (base_ < 0) base_ = now;
    now -= base_;
    if (n < kFrame + 2) { ++c_.other; return; }
    if (firstSeen_ < 0) { firstSeen_ = now; if (state_ == DlState::IDLE) go(DlState::RADIO_ON, "first wireless frame", now); }
    lastFrame_ = now;
    const uint8_t mpType = p[9];                         // 0 other, 1 reply, 2 cmd
    const uint8_t* f = p + kFrame;
    const size_t flen = n - kFrame;
    const uint16_t fc = uint16_t(f[0] | f[1] << 8);
    const unsigned type = (fc >> 2) & 3, sub = (fc >> 4) & 0xF;
    if (mpType == 2) ++c_.cmd; else if (mpType == 1) ++c_.reply;
    if (mpType) ++windowCmdReply_;

    if (type == 0) {  // management
        switch (sub) {
            case 8: {  // beacon
                tx ? ++c_.beaconsTx : ++c_.beaconsRx;
                uint32_t id = 0;
                bool nin = flen > kMgmtHdr + 12 && nintendoIe(f + kMgmtHdr + 12, flen - kMgmtHdr - 12, &id);
                if (nin) { tx ? ++c_.nintendoBeaconsTx : ++c_.nintendoBeaconsRx; c_.lastGameId = id; }
                if (tx && nin) {
                    lastBeaconTx_ = now;
                    if (c_.nintendoBeaconsTx >= 3 && (state_ == DlState::RADIO_ON || state_ == DlState::IDLE)) go(DlState::HOST_ADVERTISING, "Nintendo beacons transmitted", now);
                } else if (!tx && nin && (state_ == DlState::RADIO_ON || state_ == DlState::CLIENT_SCANNING)) {
                    go(DlState::GAME_DISCOVERED, "Nintendo beacon received from a host", now);
                }
                break;
            }
            case 4: tx ? ++c_.probeReqTx : ++c_.probeReqRx;
                if (tx && (state_ == DlState::RADIO_ON)) go(DlState::CLIENT_SCANNING, "probe request transmitted", now);
                break;
            case 5: tx ? ++c_.probeRespTx : ++c_.probeRespRx; break;
            case 11: tx ? ++c_.authTx : ++c_.authRx; break;
            case 0: tx ? ++c_.assocReqTx : ++c_.assocReqRx; break;
            case 1: tx ? ++c_.assocRespTx : ++c_.assocRespRx; break;
            case 10: case 12: ++c_.deauth; break;
            default: break;
        }
        const bool hs = (sub == 11 || sub == 0 || sub == 1);
        if (hs) {
            handshakeAt_ = now;
            if (state_ == DlState::GAME_DISCOVERED || state_ == DlState::RADIO_ON || state_ == DlState::CLIENT_SCANNING || state_ == DlState::HOST_ADVERTISING)
                go(DlState::DOWNLOAD_HANDSHAKE, "authentication/association frames", now);
            if (sub == 1) associated_ = true;
        }
    } else if (type == 2) {  // data
        if (tx) { ++c_.dataTx; c_.dataBytesTx += flen; } else { ++c_.dataRx; c_.dataBytesRx += flen; }
        // Real Mario Party DS traffic (captured): the download is a burst of ~290-byte MP command frames; waiting for the host is keep-alive polling
        // (32/42-byte commands, ~38-byte replies); the downloaded game boots while the client answers with blank 28-byte replies; the running game then
        // exchanges ~200-byte commands / ~70-byte replies at ~60 Hz (lobby and game look the same on the wire - the screen decides, see mark()).
        const unsigned frameLen = unsigned(p[20] | p[21] << 8);
        if (mpType == 2 && frameLen >= 200 && (state_ == DlState::DOWNLOAD_HANDSHAKE || state_ == DlState::DOWNLOAD_TRANSFER)) {
            ++bulkFrames_;
            lastBulkAt_ = now;
            transferBytes_ += flen;
            if (state_ == DlState::DOWNLOAD_HANDSHAKE && bulkFrames_ >= 20) go(DlState::DOWNLOAD_TRANSFER, "bulk command frames (download payload)", now);
        }
        if (mpType == 1) { if (frameLen <= 28) ++blankReplies_; else ++realReplies_; }
    } else {
        ++c_.other;
    }
}

void DlDiag::tick(double now) {
    if (base_ < 0) return;
    now -= base_;
    if (cadenceWin_ == 0) cadenceWin_ = now;
    if (now - cadenceWin_ >= kCadenceMs) {
        const uint64_t n = windowCmdReply_, blank = blankReplies_, real = realReplies_;
        windowCmdReply_ = 0; blankReplies_ = 0; realReplies_ = 0;
        cadenceWin_ = now;
        if (state_ == DlState::DOWNLOAD_VERIFY && blank >= 20) go(DlState::CLIENT_GAME_BOOT, "replies became blank: the client is booting the downloaded software", now);
        else if (state_ == DlState::CLIENT_GAME_BOOT && blank < 20 && real >= 20) go(DlState::GAME_HANDSHAKE, "regular replies resumed from the freshly booted game", now);
        else if (state_ == DlState::GAME_HANDSHAKE && n >= kInGameCadence && real >= 20) go(DlState::LOBBY, "sustained game-level command/reply cadence (lobby or game: the screen tells which)", now);
    }
    if (state_ == DlState::DOWNLOAD_TRANSFER && now - lastBulkAt_ > kTransferQuietMs) {
        transferDone_ = true;
        go(DlState::DOWNLOAD_VERIFY, "download payload complete; keep-alive polling until the host starts", now);
    }
    if (state_ == DlState::DOWNLOAD_HANDSHAKE && now - handshakeAt_ > kHandshakeTimeoutMs && bulkFrames_ < 20) go(DlState::ERROR, "handshake did not progress to a transfer", now);
}

std::string DlDiag::json() const {
    std::ostringstream o;
    o << "\"dl_state\":\"" << dlStateName(state_) << "\",\"dl_counters\":{"
      << "\"beacons_tx\":" << c_.beaconsTx << ",\"beacons_rx\":" << c_.beaconsRx << ",\"nin_beacons_tx\":" << c_.nintendoBeaconsTx << ",\"nin_beacons_rx\":" << c_.nintendoBeaconsRx
      << ",\"probe_req_tx\":" << c_.probeReqTx << ",\"probe_resp_rx\":" << c_.probeRespRx << ",\"auth_tx\":" << c_.authTx << ",\"auth_rx\":" << c_.authRx
      << ",\"assoc_req_tx\":" << c_.assocReqTx << ",\"assoc_req_rx\":" << c_.assocReqRx << ",\"assoc_resp_tx\":" << c_.assocRespTx << ",\"assoc_resp_rx\":" << c_.assocRespRx
      << ",\"deauth\":" << c_.deauth << ",\"data_tx\":" << c_.dataTx << ",\"data_rx\":" << c_.dataRx << ",\"data_bytes_tx\":" << c_.dataBytesTx << ",\"data_bytes_rx\":" << c_.dataBytesRx
      << ",\"cmd\":" << c_.cmd << ",\"reply\":" << c_.reply << "},\"dl_hist\":[";
    size_t from = hist_.size() > 40 ? hist_.size() - 40 : 0;
    for (size_t i = from; i < hist_.size(); i++) {
        const auto& t = hist_[i];
        if (i > from) o << ',';
        o << "{\"t\":" << long(t.tMs) << ",\"dur\":" << long(t.prevDurationMs) << ",\"from\":\"" << dlStateName(t.from) << "\",\"to\":\"" << dlStateName(t.to) << "\"}";
    }
    o << ']';
    return o.str();
}

}  // namespace dsrt
