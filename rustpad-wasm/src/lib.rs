//! Core logic for Rustpad, shared with the client through WebAssembly.

#![warn(missing_docs)]

use operational_transform::OperationSeq;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

pub mod utils;

/// This is an wrapper around `operational_transform::OperationSeq`, which is
/// necessary for Wasm compatibility through `wasm-bindgen`.
#[wasm_bindgen]
#[derive(Default, Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OpSeq(OperationSeq);

/// This is a pair of `OpSeq` structs, which is needed to handle some return
/// values from `wasm-bindgen`.
#[wasm_bindgen]
#[derive(Default, Clone, Debug, PartialEq)]
pub struct OpSeqPair(OpSeq, OpSeq);

impl OpSeq {
    /// Transforms two operations A and B that happened concurrently and produces
    /// two operations A' and B' (in an array) such that
    ///     `apply(apply(S, A), B') = apply(apply(S, B), A')`.
    /// This function is the heart of OT.
    ///
    /// Unlike `OpSeq::transform`, this function returns a raw tuple, which is
    /// more efficient but cannot be exported by `wasm-bindgen`.
    ///
    /// # Error
    ///
    /// Returns `None` if the operations cannot be transformed due to
    /// length conflicts.
    pub fn transform_raw(&self, other: &OpSeq) -> Option<(OpSeq, OpSeq)> {
        let (a, b) = self.0.transform(&other.0).ok()?;
        Some((Self(a), Self(b)))
    }
}

#[wasm_bindgen]
impl OpSeq {
    /// Creates a default empty `OpSeq`.
    pub fn new() -> Self {
        Self::default()
    }

    /// Creates a store for operatations which does not need to allocate  until
    /// `capacity` operations have been stored inside.
    pub fn with_capacity(capacity: usize) -> Self {
        Self(OperationSeq::with_capacity(capacity))
    }

    /// Merges the operation with `other` into one operation while preserving
    /// the changes of both. Or, in other words, for each input string S and a
    /// pair of consecutive operations A and B.
    ///     `apply(apply(S, A), B) = apply(S, compose(A, B))`
    /// must hold.
    ///
    /// # Error
    ///
    /// Returns `None` if the operations are not composable due to length
    /// conflicts.
    pub fn compose(&self, other: &OpSeq) -> Option<OpSeq> {
        self.0.compose(&other.0).ok().map(Self)
    }

    /// Deletes `n` characters at the current cursor position.
    pub fn delete(&mut self, n: u32) {
        self.0.delete(n as u64)
    }

    /// Inserts a `s` at the current cursor position.
    pub fn insert(&mut self, s: &str) {
        self.0.insert(s)
    }

    /// Moves the cursor `n` characters forwards.
    pub fn retain(&mut self, n: u32) {
        self.0.retain(n as u64)
    }

    /// Transforms two operations A and B that happened concurrently and produces
    /// two operations A' and B' (in an array) such that
    ///     `apply(apply(S, A), B') = apply(apply(S, B), A')`.
    /// This function is the heart of OT.
    ///
    /// # Error
    ///
    /// Returns `None` if the operations cannot be transformed due to
    /// length conflicts.
    pub fn transform(&self, other: &OpSeq) -> Option<OpSeqPair> {
        let (a, b) = self.0.transform(&other.0).ok()?;
        Some(OpSeqPair(Self(a), Self(b)))
    }

    /// Applies an operation to a string, returning a new string.
    ///
    /// # Error
    ///
    /// Returns an error if the operation cannot be applied due to length
    /// conflicts.
    pub fn apply(&self, s: &str) -> Option<String> {
        self.0.apply(s).ok()
    }

    /// Computes the inverse of an operation. The inverse of an operation is the
    /// operation that reverts the effects of the operation, e.g. when you have
    /// an operation 'insert("hello "); skip(6);' then the inverse is
    /// 'delete("hello "); skip(6);'. The inverse should be used for
    /// implementing undo.
    pub fn invert(&self, s: &str) -> Self {
        Self(self.0.invert(s))
    }

    /// Checks if this operation has no effect.
    #[inline]
    pub fn is_noop(&self) -> bool {
        self.0.is_noop()
    }

    /// Returns the length of a string these operations can be applied to
    #[inline]
    pub fn base_len(&self) -> usize {
        self.0.base_len()
    }

    /// Returns the length of the resulting string after the operations have
    /// been applied.
    #[inline]
    pub fn target_len(&self) -> usize {
        self.0.target_len()
    }

    /// Return the new index of a position in the string.
    pub fn transform_index(&self, position: u32) -> u32 {
        let mut index = position as i32;
        let mut new_index = index;
        for op in self.0.ops() {
            use operational_transform::Operation::*;
            match op {
                &Retain(n) => index -= n as i32,
                Insert(s) => new_index += bytecount::num_chars(s.as_bytes()) as i32,
                &Delete(n) => {
                    new_index -= std::cmp::min(index, n as i32);
                    index -= n as i32;
                }
            }
            if index < 0 {
                break;
            }
        }
        new_index as u32
    }

    /// Attempts to deserialize an `OpSeq` from a JSON string.
    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Option<OpSeq> {
        serde_json::from_str(s).ok()
    }

    /// Converts this object to a JSON string.
    #[allow(clippy::inherent_to_string)]
    pub fn to_string(&self) -> String {
        serde_json::to_string(self).expect("json serialization failure")
    }
}

#[wasm_bindgen]
impl OpSeqPair {
    /// Returns the first element of the pair.
    pub fn first(&self) -> OpSeq {
        self.0.clone()
    }

    /// Returns the second element of the pair.
    pub fn second(&self) -> OpSeq {
        self.1.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic stand-in for randomness: no dev-dependency, and a failure
    /// reproduces exactly.
    struct Lcg(u64);

    impl Lcg {
        fn below(&mut self, bound: u32) -> u32 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            if bound == 0 {
                0
            } else {
                (self.0 >> 33) as u32 % bound
            }
        }
    }

    /// An operation that consumes the whole document — retain a prefix, edit,
    /// then delete what is left. Anything shorter is a length conflict, which is
    /// why an earlier version of these tests transformed almost nothing.
    fn random_op(doc_len: u32, rng: &mut Lcg) -> OpSeq {
        let mut op = OpSeq::new();
        let keep = rng.below(doc_len + 1);
        op.retain(keep);
        let mut consumed = 0;
        match rng.below(3) {
            0 => op.insert("z"),
            1 => op.insert("qr"),
            _ => {
                let delete = rng.below(doc_len - keep + 1);
                if delete > 0 {
                    op.delete(delete);
                    consumed = delete;
                }
            }
        }
        let rest = doc_len - keep - consumed;
        if rest > 0 {
            op.delete(rest);
        }
        op
    }

    /// The property this crate exists to provide: two operations that happened
    /// concurrently reach the same document whichever order they arrive in,
    /// because arrival order is decided by the network and not by the users.
    #[test]
    fn concurrent_operations_converge() {
        let base = "the quick brown fox jumps";
        let len = base.len() as u32;
        let mut rng = Lcg(0x5EED_1234);
        let (mut checked, mut skipped) = (0, 0);
        for _ in 0..2000 {
            let a = random_op(len, &mut rng);
            let b = random_op(len, &mut rng);
            let Some((a_prime, b_prime)) = a.transform_raw(&b) else {
                skipped += 1;
                continue;
            };
            let via_a = a.apply(base).and_then(|x| b_prime.apply(&x));
            let via_b = b.apply(base).and_then(|x| a_prime.apply(&x));
            match (via_a, via_b) {
                (Some(x), Some(y)) => {
                    assert_eq!(x, y, "A={:?} B={:?} diverged", a, b);
                    checked += 1;
                }
                (None, None) => skipped += 1,
                (x, y) => panic!("only one side applied: {:?} vs {:?}", x, y),
            }
        }
        assert!(checked > 1500, "only {checked} pairs converged ({skipped} skipped)");
    }

    /// Composition must agree with applying in sequence, or consecutive edits
    /// coalesced before sending would corrupt the document in transit.
    #[test]
    fn composing_matches_applying_in_sequence() {
        let base = "hello world";
        let mut rng = Lcg(0x00C0_FFEE);
        let mut checked = 0;
        for _ in 0..500 {
            let a = random_op(base.len() as u32, &mut rng);
            let Some(after_a) = a.apply(base) else { continue };
            let b = random_op(after_a.len() as u32, &mut rng);
            let Some(both) = a.compose(&b) else { continue };
            let sequential = b.apply(&after_a).expect("B applies to A's result");
            assert_eq!(
                both.apply(base).expect("the composition applies"),
                sequential,
                "A={:?} B={:?}",
                a,
                b
            );
            checked += 1;
        }
        assert!(checked > 400, "only {checked} pairs composed");
    }

    /// Undo: the inverse of an operation, applied to that operation's result,
    /// restores the original text. The editor builds `Ctrl+Z` from this, so an
    /// inverse that is wrong only for deletions would quietly destroy text.
    #[test]
    fn inverting_undoes_an_operation() {
        let base = "the quick brown fox jumps";
        let mut rng = Lcg(0x5EED_0002);
        let mut checked = 0;
        for _ in 0..1000 {
            let a = random_op(base.len() as u32, &mut rng);
            let Some(after_a) = a.apply(base) else { continue };
            let undo = a.invert(base);
            assert_eq!(
                undo.apply(&after_a).expect("the inverse applies"),
                base,
                "A={:?} did not undo",
                a
            );
            checked += 1;
        }
        assert!(checked > 900, "only {checked} pairs inverted");
    }

    /// Cursor maintenance across two successive edits: moving a caret through
    /// A and then through B must land where a single walk through the composed
    /// operation does, or the caret jumps when the server merges input.
    #[test]
    fn transform_index_composes_with_the_operations() {
        let mut rng = Lcg(0x000C_0DE5);
        for _ in 0..400 {
            let start = "hello world";
            let a = random_op(start.len() as u32, &mut rng);
            let Some(after_a) = a.apply(start) else { continue };
            let b = random_op(after_a.len() as u32, &mut rng);
            let Some(ab) = a.compose(&b) else { continue };
            for position in 0..=start.len() as u32 {
                let stepwise = b.transform_index(a.transform_index(position));
                assert_eq!(
                    stepwise,
                    ab.transform_index(position),
                    "caret {position} through A={:?} B={:?}",
                    a,
                    b
                );
            }
        }
    }

    /// A caret inside text that another user deletes collapses to the point of
    /// deletion; one after it shifts left by exactly what was removed.
    #[test]
    fn transform_index_handles_deletion_ranges() {
        let mut op = OpSeq::new();
        op.retain(3);
        op.delete(4);
        assert_eq!(op.transform_index(0), 0, "before the delete");
        assert_eq!(op.transform_index(3), 3, "at the delete start");
        assert_eq!(op.transform_index(5), 3, "inside the deleted text");
        assert_eq!(op.transform_index(9), 5, "after the deleted text");
        assert_eq!(op.transform_index(20), 16, "past the end still shifts by 4");

        let mut ins = OpSeq::new();
        ins.retain(2);
        ins.insert("abc");
        assert_eq!(ins.transform_index(1), 1, "before the insert");
        assert_eq!(ins.transform_index(4), 7, "after the insert");

        let noop = OpSeq::new();
        assert_eq!(noop.transform_index(7), 7, "an empty operation moves nothing");
    }
}
