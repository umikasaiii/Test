#include "dslink/latency.hpp"

#include <algorithm>
#include <cmath>

namespace dslink {

const char* qualityCode(Quality q) {
    switch (q) {
        case Quality::Unknown: return "UNKNOWN";
        case Quality::Excellent: return "EXCELLENT";
        case Quality::Good: return "GOOD";
        case Quality::Insufficient: return "INSUFFICIENT";
    }
    return "UNKNOWN";
}

std::string qualityLabel(Quality q) {
    switch (q) {
        case Quality::Unknown: return "Sconosciuta";
        case Quality::Excellent: return "Ottima";
        case Quality::Good: return "Buona";
        case Quality::Insufficient: return "Insufficiente";
    }
    return "Sconosciuta";
}

void LatencyTracker::onReply(double rtt) {
    if (received_ == 0) { min_ = max_ = rtt; }
    else {
        min_ = std::min(min_, rtt);
        max_ = std::max(max_, rtt);
        jitter_ += (std::fabs(rtt - last_) - jitter_) / 16.0;
    }
    last_ = rtt;
    sum_ += rtt;
    ++received_;
}

LatencyStats LatencyTracker::stats() const {
    LatencyStats s;
    s.sent = std::max(sent_, received_);
    s.received = received_;
    s.minMs = min_; s.maxMs = max_; s.jitterMs = jitter_; s.lastMs = last_;
    s.avgMs = received_ ? sum_ / received_ : 0;
    s.lossPercent = s.sent ? 100.0 * double(s.sent - s.received) / s.sent : 0;
    return s;
}

Quality LatencyTracker::quality(const QualityThresholds& t) const { return classify(stats(), t); }

Quality classify(const LatencyStats& s, const QualityThresholds& t) {
    if (s.sent == 0) return Quality::Unknown;
    if (s.received == 0 || s.lossPercent > t.maxLossPercent) return Quality::Insufficient;
    if (s.avgMs <= t.excellentRttMs && s.jitterMs <= t.excellentJitterMs && s.lossPercent == 0)
        return Quality::Excellent;
    if (s.avgMs <= t.goodRttMs && s.jitterMs <= t.goodJitterMs) return Quality::Good;
    return Quality::Insufficient;
}

}  // namespace dslink
