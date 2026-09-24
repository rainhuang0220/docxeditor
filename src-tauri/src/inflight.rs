//! Explicit ownership for one desktop stream.
//!
//! absent → reserve → reserved → start → active → finish → absent.
//! Cancel of a reservation marks that owner cancelled. Cancel of an unknown
//! id, or of a different owner, does not create or replace state.

use std::collections::HashMap;

use tokio::sync::watch;

enum Slot {
    Reserved { owner: String },
    Active { sender: watch::Sender<bool>, owner: String },
    Cancelled { owner: String },
}

pub enum Reserve {
    Reserved,
    Duplicate,
}

pub enum Start {
    Ready(watch::Receiver<bool>),
    Cancelled,
    Duplicate,
    NotReserved,
}

pub struct Inflight {
    slots: HashMap<String, Slot>,
}

impl Inflight {
    pub fn new() -> Self {
        Self { slots: HashMap::new() }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.slots.len()
    }

    pub fn reserve(&mut self, id: &str, owner: &str) -> Reserve {
        if id.is_empty() || owner.is_empty() || self.slots.contains_key(id) {
            return Reserve::Duplicate;
        }
        self.slots.insert(id.to_string(), Slot::Reserved { owner: owner.to_string() });
        Reserve::Reserved
    }

    pub fn start(&mut self, id: &str, owner: &str) -> Start {
        match self.slots.get(id) {
            Some(Slot::Cancelled { owner: current }) if current == owner => {
                self.slots.remove(id);
                return Start::Cancelled;
            }
            Some(Slot::Reserved { owner: current }) if current == owner => {}
            Some(Slot::Active { .. }) => return Start::Duplicate,
            _ => return Start::NotReserved,
        }
        let (sender, receiver) = watch::channel(false);
        self.slots.insert(
            id.to_string(),
            Slot::Active { sender, owner: owner.to_string() },
        );
        Start::Ready(receiver)
    }

    pub fn cancel(&mut self, id: &str, owner: &str) {
        match self.slots.get_mut(id) {
            Some(Slot::Active { owner: current, sender }) if current == owner => {
                let _ = sender.send(true);
                return;
            }
            Some(Slot::Reserved { owner: current }) if current == owner => {}
            _ => return,
        }
        self.slots.insert(id.to_string(), Slot::Cancelled { owner: owner.to_string() });
    }

    /// Drops a reservation that has not started. An active stream stays owned
    /// by its start token, so a late release cannot remove a newer request.
    pub fn release(&mut self, id: &str, owner: &str) {
        match self.slots.get(id) {
            Some(Slot::Reserved { owner: current }) | Some(Slot::Cancelled { owner: current })
                if current == owner =>
            {
                self.slots.remove(id);
            }
            _ => {}
        }
    }

    /// Removes the active stream for this owner, or a cancelled reservation
    /// that belongs to the same owner. A different owner is left untouched.
    pub fn finish(&mut self, id: &str, owner: &str) {
        let remove = match self.slots.get(id) {
            Some(Slot::Active { owner: current, .. }) if current == owner => true,
            Some(Slot::Cancelled { owner: current }) if current == owner => true,
            _ => false,
        };
        if remove {
            self.slots.remove(id);
        }
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
    fn reserve_start_finish_leaves_nothing() {
        let mut inflight = Inflight::new();
        assert!(matches!(inflight.reserve("r", "o"), Reserve::Reserved));
        assert!(matches!(inflight.start("r", "o"), Start::Ready(_)));
        inflight.finish("r", "o");
        assert_eq!(inflight.len(), 0);
    }

    #[test]
    fn reserve_cancel_start_does_not_arm_http() {
        let mut inflight = Inflight::new();
        inflight.reserve("r", "o");
        inflight.cancel("r", "o");
        assert!(matches!(inflight.start("r", "o"), Start::Cancelled));
        assert_eq!(inflight.len(), 0);
    }

    #[test]
    fn reserve_cancel_finish_leaves_nothing() {
        let mut inflight = Inflight::new();
        inflight.reserve("r", "o");
        inflight.cancel("r", "o");
        inflight.finish("r", "o");
        assert_eq!(inflight.len(), 0);
        assert!(matches!(inflight.start("r", "o"), Start::NotReserved));
    }

    #[test]
    fn active_cancel_signals_only_that_request() {
        let mut inflight = Inflight::new();
        inflight.reserve("a", "oa");
        inflight.reserve("b", "ob");
        let Start::Ready(mut a) = inflight.start("a", "oa") else { panic!("a") };
        let Start::Ready(b) = inflight.start("b", "ob") else { panic!("b") };
        inflight.cancel("a", "oa");
        assert!(*a.borrow_and_update());
        assert!(!*b.borrow());
        assert_eq!(inflight.len(), 2);
    }

    #[test]
    fn finish_then_late_cancel_stays_empty() {
        let mut inflight = Inflight::new();
        inflight.reserve("r", "o");
        let _ = inflight.start("r", "o");
        inflight.finish("r", "o");
        inflight.cancel("r", "o");
        inflight.release("r", "o");
        assert_eq!(inflight.len(), 0);
        assert!(matches!(inflight.start("r", "o"), Start::NotReserved));
    }

    #[test]
    fn unknown_cancel_creates_nothing() {
        let mut inflight = Inflight::new();
        inflight.cancel("never", "o");
        inflight.release("never", "o");
        assert_eq!(inflight.len(), 0);
        assert!(matches!(inflight.start("never", "o"), Start::NotReserved));
    }

    #[test]
    fn thousands_of_late_cancels_do_not_grow() {
        let mut inflight = Inflight::new();
        for index in 0..5_000 {
            let id = format!("gone-{index}");
            inflight.cancel(&id, "o");
            inflight.release(&id, "o");
            inflight.finish(&id, "o");
        }
        assert_eq!(inflight.len(), 0);
    }

    #[test]
    fn duplicate_reserve_keeps_the_first_owner() {
        let mut inflight = Inflight::new();
        assert!(matches!(inflight.reserve("r", "first"), Reserve::Reserved));
        assert!(matches!(inflight.reserve("r", "second"), Reserve::Duplicate));
        inflight.cancel("r", "second");
        assert!(matches!(inflight.start("r", "first"), Start::Ready(_)));
        assert_eq!(inflight.len(), 1);
        inflight.cancel("r", "first");
        inflight.finish("r", "first");
        assert_eq!(inflight.len(), 0);
    }

    #[test]
    fn duplicate_start_keeps_the_first_sender() {
        let mut inflight = Inflight::new();
        inflight.reserve("r", "o");
        let Start::Ready(mut first) = inflight.start("r", "o") else { panic!("first") };
        assert!(matches!(inflight.start("r", "o"), Start::Duplicate));
        assert!(matches!(inflight.start("r", "other"), Start::Duplicate));
        inflight.cancel("r", "other");
        assert!(!*first.borrow());
        inflight.cancel("r", "o");
        assert!(*first.borrow_and_update());
        assert_eq!(inflight.len(), 1);
        inflight.finish("r", "o");
        assert_eq!(inflight.len(), 0);
    }

    #[test]
    fn finish_and_cancel_do_not_touch_another_request() {
        let mut inflight = Inflight::new();
        inflight.reserve("a", "oa");
        inflight.reserve("b", "ob");
        let Start::Ready(b) = inflight.start("b", "ob") else { panic!("b") };
        inflight.finish("a", "oa");
        inflight.cancel("a", "oa");
        inflight.release("a", "oa");
        assert_eq!(inflight.len(), 1);
        assert!(!*b.borrow());
        inflight.finish("b", "ob");
        assert_eq!(inflight.len(), 0);
    }

    #[test]
    fn failed_setup_releases_the_reservation() {
        let mut inflight = Inflight::new();
        inflight.reserve("r", "o");
        inflight.release("r", "o");
        assert_eq!(inflight.len(), 0);
        assert!(matches!(inflight.start("r", "o"), Start::NotReserved));
        inflight.cancel("r", "o");
        assert_eq!(inflight.len(), 0);
    }

    #[test]
    fn release_does_not_remove_an_active_stream() {
        let mut inflight = Inflight::new();
        inflight.reserve("r", "o");
        let Start::Ready(mut receiver) = inflight.start("r", "o") else { panic!("start") };
        inflight.release("r", "o");
        assert_eq!(inflight.len(), 1);
        inflight.cancel("r", "o");
        assert!(*receiver.borrow_and_update());
        inflight.finish("r", "o");
        assert_eq!(inflight.len(), 0);
    }

    #[test]
    fn stale_owner_cannot_mutate_a_reused_id() {
        let mut inflight = Inflight::new();
        inflight.reserve("r", "old");
        let _ = inflight.start("r", "old");
        inflight.finish("r", "old");
        inflight.reserve("r", "new");
        let Start::Ready(mut receiver) = inflight.start("r", "new") else { panic!("new") };
        inflight.finish("r", "old");
        inflight.release("r", "old");
        inflight.cancel("r", "old");
        assert_eq!(inflight.len(), 1);
        assert!(!*receiver.borrow());
        inflight.cancel("r", "new");
        assert!(*receiver.borrow_and_update());
        inflight.finish("r", "new");
        assert_eq!(inflight.len(), 0);
    }

    #[test]
    fn backend_retry_leaves_no_stale_ownership() {
        let mut inflight = Inflight::new();
        inflight.reserve("old", "old-owner");
        let Start::Ready(mut old_rx) = inflight.start("old", "old-owner") else { panic!("old") };
        inflight.reserve("newer", "newer-owner");
        inflight.cancel("old", "old-owner");
        assert!(*old_rx.borrow_and_update());
        inflight.finish("old", "old-owner");
        inflight.cancel("old", "old-owner");
        inflight.release("old", "old-owner");
        assert_eq!(inflight.len(), 1);
        let Start::Ready(mut newer_rx) = inflight.start("newer", "newer-owner") else { panic!("newer") };
        inflight.finish("old", "old-owner");
        assert!(!*newer_rx.borrow());
        inflight.cancel("newer", "newer-owner");
        assert!(*newer_rx.borrow_and_update());
        inflight.finish("newer", "newer-owner");
        inflight.reserve("old", "reborn");
        inflight.release("old", "old-owner");
        inflight.cancel("old", "old-owner");
        assert_eq!(inflight.len(), 1);
        inflight.release("old", "reborn");
        for index in 0..5_000 {
            inflight.cancel(&format!("retry-late-{index}"), "old-owner");
        }
        assert_eq!(inflight.len(), 0);
    }
}
