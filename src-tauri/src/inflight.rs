//! Cancellation ownership for one desktop process.
//!
//! A cancel that arrives before the stream is registered is remembered.
//! A second registration of an active id is rejected and does not replace
//! the first sender. Finishing one id cannot remove another.

use std::collections::{HashMap, HashSet};

use tokio::sync::watch;

pub struct Inflight {
    slots: HashMap<String, watch::Sender<bool>>,
    pending_cancel: HashSet<String>,
}

pub enum Registration {
    Ready(watch::Receiver<bool>),
    Cancelled,
    Duplicate,
}

impl Inflight {
    pub fn new() -> Self {
        Self { slots: HashMap::new(), pending_cancel: HashSet::new() }
    }

    pub fn register(&mut self, id: &str) -> Registration {
        if self.pending_cancel.remove(id) {
            return Registration::Cancelled;
        }
        if self.slots.contains_key(id) {
            return Registration::Duplicate;
        }
        let (sender, receiver) = watch::channel(false);
        self.slots.insert(id.to_string(), sender);
        Registration::Ready(receiver)
    }

    pub fn cancel(&mut self, id: &str) {
        if let Some(sender) = self.slots.get(id) {
            let _ = sender.send(true);
            return;
        }
        self.pending_cancel.insert(id.to_string());
    }

    pub fn finish(&mut self, id: &str) {
        self.slots.remove(id);
    }

    #[cfg(test)]
    pub fn contains(&self, id: &str) -> bool {
        self.slots.contains_key(id)
    }
}

impl Default for Inflight {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_before_register_does_not_start() {
        let mut inflight = Inflight::new();
        inflight.cancel("req");
        assert!(matches!(inflight.register("req"), Registration::Cancelled));
        assert!(!inflight.contains("req"));
    }

    #[test]
    fn duplicate_id_keeps_the_first_sender() {
        let mut inflight = Inflight::new();
        let Registration::Ready(mut first) = inflight.register("req") else { panic!("first") };
        assert!(matches!(inflight.register("req"), Registration::Duplicate));
        inflight.cancel("req");
        assert!(*first.borrow_and_update());
        assert!(inflight.contains("req"));
    }

    #[test]
    fn finish_removes_only_that_id() {
        let mut inflight = Inflight::new();
        let _ = inflight.register("a");
        let _ = inflight.register("b");
        inflight.finish("a");
        assert!(!inflight.contains("a"));
        assert!(inflight.contains("b"));
        inflight.cancel("b");
        assert!(inflight.contains("b"));
    }
}
