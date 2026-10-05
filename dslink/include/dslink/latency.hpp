// DSLink - network quality metrics (RTT, jitter, loss).
// The DS wireless protocol has very tight timing. The quality thresholds below are PROVISIONAL engineering
// guesses (see docs/MULTIPLAYER.md) and must be calibrated on real devices before being trusted.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace dslink {

enum class Quality { Unknown, Excellent, Good, Insufficient };
const char* qualityCode(Quality q);
std::string qualityLabel(Quality q);  // Italian: Ottima / Buona / Insufficiente

struct QualityThresholds {
    double excellentRttMs = 10.0;
    double excellentJitterMs = 4.0;
    double goodRttMs = 25.0;
    double goodJitterMs = 10.0;
    double maxLossPercent = 2.0;  // above this the link is Insufficient
};

struct LatencyStats {
    unsigned sent = 0, received = 0;
    double minMs = 0, avgMs = 0, maxMs = 0, jitterMs = 0, lossPercent = 0, lastMs = 0;
};

class LatencyTracker {
public:
    void onSent() { ++sent_; }
    void onReply(double rttMs);  // jitter = RFC 3550 smoothed mean deviation of consecutive RTTs
    LatencyStats stats() const;
    Quality quality(const QualityThresholds& t = {}) const;

private:
    unsigned sent_ = 0, received_ = 0;
    double min_ = 0, max_ = 0, sum_ = 0, jitter_ = 0, last_ = 0;
};

Quality classify(const LatencyStats& s, const QualityThresholds& t = {});

}  // namespace dslink
