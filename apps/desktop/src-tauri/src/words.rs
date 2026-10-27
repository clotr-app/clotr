//! The few words Clotr for Windows says outside its pages (the tray's menu), from apps/locales, in the system's
//! language: English when a language or a word is missing.

use serde_json::{Map, Value};

const EN: &str = include_str!("../../../locales/en.json");
const ES: &str = include_str!("../../../locales/es.json");

pub struct Words {
    own: Map<String, Value>,
    en: Map<String, Value>,
}

fn read(text: &str) -> Map<String, Value> {
    serde_json::from_str(text).unwrap_or_default()
}

impl Words {
    pub fn new(locale: &str) -> Words {
        let lang = locale.split(['-', '_']).next().unwrap_or("en").to_ascii_lowercase();
        let own = if lang == "es" { read(ES) } else { Map::new() };
        Words { own, en: read(EN) }
    }

    pub fn t(&self, key: &str) -> String {
        self.own
            .get(key)
            .or_else(|| self.en.get(key))
            .and_then(Value::as_str)
            .unwrap_or(key)
            .to_string()
    }

    /// `t`, with the word's own "$1" filled in (the pages' `W.t(key, ...args)` does the same, in JS).
    pub fn t1(&self, key: &str, value: impl std::fmt::Display) -> String {
        self.t(key).replacen("$1", &value.to_string(), 1)
    }
}

/// The language every window speaks: Settings' Language when the person picked English or Spanish there, the
/// system's own otherwise ("Like Windows", or nothing saved yet). main.js picks the same way for the main window.
pub fn effective_locale(language: Option<&str>, system: &str) -> String {
    match language {
        Some(picked @ ("en" | "es")) => picked.to_string(),
        _ => system.to_string(),
    }
}

/// The system's display language, as Windows names it ("en-US", "es-MX"). The DK checks' build may ask for another
/// (CLOTR_LOCALE), to see the windows in each language.
pub fn system_locale() -> String {
    #[cfg(feature = "dk-test-app")]
    if let Ok(asked) = std::env::var("CLOTR_LOCALE") {
        return asked;
    }
    use windows::Win32::Globalization::{GetUserDefaultUILanguage, LCIDToLocaleName, LOCALE_ALLOW_NEUTRAL_NAMES};
    let mut name = [0u16; 85];
    let n = unsafe {
        LCIDToLocaleName(
            GetUserDefaultUILanguage() as u32,
            Some(&mut name),
            LOCALE_ALLOW_NEUTRAL_NAMES,
        )
    };
    if n > 1 {
        String::from_utf16_lossy(&name[..n as usize - 1])
    } else {
        "en".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_english_word_has_a_spanish_one_and_the_same_placeholders() {
        let (en, es) = (read(EN), read(ES));
        assert!(!en.is_empty());
        let mut en_keys: Vec<&String> = en.keys().collect();
        let mut es_keys: Vec<&String> = es.keys().collect();
        en_keys.sort();
        es_keys.sort();
        assert_eq!(en_keys, es_keys);
        for (k, v) in &en {
            let holders = |s: &str| (1..=9).filter(|n| s.contains(&format!("${n}"))).collect::<Vec<_>>();
            assert_eq!(holders(v.as_str().unwrap()), holders(es[k].as_str().unwrap()), "{k}");
        }
    }

    #[test]
    fn spanish_for_spanish_and_english_for_the_rest() {
        assert_eq!(Words::new("es-MX").t("tray.quit"), "Salir de Clotr");
        assert_eq!(Words::new("fr-FR").t("tray.quit"), "Quit Clotr");
        assert_eq!(Words::new("es").t("no.such.word"), "no.such.word");
    }

    #[test]
    fn settings_language_wins_over_the_systems_only_when_its_english_or_spanish() {
        assert_eq!(effective_locale(Some("es"), "en-US"), "es");
        assert_eq!(effective_locale(Some("en"), "es-MX"), "en");
        assert_eq!(effective_locale(Some("system"), "es-MX"), "es-MX", "Like Windows");
        assert_eq!(effective_locale(None, "es-MX"), "es-MX", "nothing saved yet");
        assert_eq!(effective_locale(Some("fr"), "en-GB"), "en-GB", "a language Clotr doesn't have");
        assert_eq!(Words::new(&effective_locale(Some("es"), "en-US")).t("tray.quit"), "Salir de Clotr");
    }

    #[test]
    fn t1_fills_in_the_words_own_placeholder_only() {
        assert_eq!(Words::new("en").t1("ws.notify", 3), "Clotr's weekly check found 3 new files worth a look.");
    }
}
