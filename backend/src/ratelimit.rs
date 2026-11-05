//! A small in-memory sliding-window rate limiter (per server instance).

use std::{
    collections::{HashMap, VecDeque},
    sync::Mutex,
    time::{Duration, Instant},
};

#[derive(Default)]
pub struct RateLimiter {
    hits: Mutex<HashMap<String, VecDeque<Instant>>>,
}

impl RateLimiter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a hit. `Err(seconds)` (time until a slot frees up) when `max` hits already
    /// happened within `window`.
    pub fn hit(&self, key: &str, max: u32, window: Duration) -> Result<(), u64> {
        self.record(key, max, window, true)
    }

    /// Like `hit` but does not count: "would this be allowed right now?".
    pub fn check(&self, key: &str, max: u32, window: Duration) -> Result<(), u64> {
        self.record(key, max, window, false)
    }

    pub fn clear(&self, key: &str) {
        self.hits.lock().unwrap().remove(key);
    }

    fn record(&self, key: &str, max: u32, window: Duration, count: bool) -> Result<(), u64> {
        let now = Instant::now();
        let mut map = self.hits.lock().unwrap();
        let q = map.entry(key.to_string()).or_default();
        while q.front().is_some_and(|t| now.duration_since(*t) >= window) {
            q.pop_front();
        }
        if q.len() as u32 >= max {
            let wait = window.saturating_sub(now.duration_since(*q.front().unwrap()));
            return Err(wait.as_secs().max(1));
        }
        if count {
            q.push_back(now);
        } else if q.is_empty() {
            map.remove(key); // do not let probes grow the map
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_after_max_and_reports_retry_after() {
        let l = RateLimiter::new();
        let w = Duration::from_secs(60);
        for _ in 0..3 {
            assert!(l.hit("k", 3, w).is_ok());
        }
        let wait = l.hit("k", 3, w).unwrap_err();
        assert!((1..=60).contains(&wait));
        assert!(l.hit("other", 3, w).is_ok(), "keys are independent");
    }

    #[test]
    fn check_does_not_count_and_clear_resets() {
        let l = RateLimiter::new();
        let w = Duration::from_secs(60);
        for _ in 0..10 {
            assert!(l.check("k", 1, w).is_ok());
        }
        assert!(l.hit("k", 1, w).is_ok());
        assert!(l.check("k", 1, w).is_err());
        l.clear("k");
        assert!(l.check("k", 1, w).is_ok());
    }

    #[test]
    fn old_hits_expire() {
        let l = RateLimiter::new();
        let w = Duration::from_millis(30);
        assert!(l.hit("k", 1, w).is_ok());
        assert!(l.hit("k", 1, w).is_err());
        std::thread::sleep(Duration::from_millis(40));
        assert!(l.hit("k", 1, w).is_ok());
    }
}
