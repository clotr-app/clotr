//! Home's status: one of four states, decided in one place so the page only has to show
//! what it's told. Quiet and worth a look come from what the last check found; paused and not running say why
//! Clotr isn't checking right now. Not running wins over paused (there's nothing to resume if it can't watch at
//! all); paused wins over worth a look (a find from before the pause still waits, but Clotr isn't adding to it).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Quiet,
    Look,
    Paused,
    NotRunning,
}

impl Status {
    /// The word main.rs hands to the page (ClotrHome in home.js reads it from `view.status`).
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Quiet => "quiet",
            Status::Look => "look",
            Status::Paused => "paused",
            Status::NotRunning => "notRunning",
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct StatusInput {
    /// False only when Clotr's copy check can't run at all (today: forced true for tests; nothing in the trial
    /// flips it yet, since the real triggers (the card's web view failing to start, no known AI app) aren't
    /// wired to it until a later piece needs them).
    pub watching: bool,
    pub paused: bool,
    /// True once something from the last check still waits for the person to handle or ignore it. Nothing sets
    /// this yet (Home's scan tiles stay "Coming" until the scan waves land); the scan pieces will.
    pub worth_a_look: bool,
}

pub fn status(input: StatusInput) -> Status {
    if !input.watching {
        Status::NotRunning
    } else if input.paused {
        Status::Paused
    } else if input.worth_a_look {
        Status::Look
    } else {
        Status::Quiet
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(watching: bool, paused: bool, worth_a_look: bool) -> StatusInput {
        StatusInput {
            watching,
            paused,
            worth_a_look,
        }
    }

    #[test]
    fn quiet_when_watching_and_nothing_found() {
        assert_eq!(status(input(true, false, false)), Status::Quiet);
    }

    #[test]
    fn look_when_something_still_waits() {
        assert_eq!(status(input(true, false, true)), Status::Look);
    }

    #[test]
    fn paused_when_the_person_paused_it() {
        assert_eq!(status(input(true, true, false)), Status::Paused);
    }

    #[test]
    fn paused_beats_a_find_from_before_the_pause() {
        assert_eq!(status(input(true, true, true)), Status::Paused);
    }

    #[test]
    fn not_running_beats_everything_else() {
        assert_eq!(status(input(false, false, false)), Status::NotRunning);
        assert_eq!(status(input(false, true, false)), Status::NotRunning);
        assert_eq!(status(input(false, false, true)), Status::NotRunning);
        assert_eq!(status(input(false, true, true)), Status::NotRunning);
    }

    #[test]
    fn as_str_matches_what_home_js_expects() {
        assert_eq!(status(input(true, false, false)).as_str(), "quiet");
        assert_eq!(status(input(true, false, true)).as_str(), "look");
        assert_eq!(status(input(true, true, false)).as_str(), "paused");
        assert_eq!(status(input(false, false, false)).as_str(), "notRunning");
    }
}
