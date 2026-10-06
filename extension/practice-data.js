// The practice page's made-up messages: six drills, each a scam message, a made-up reply, and a safer one, plus
// Spot the leak's 24 messages typed into an AI chat, half with something private and half without. Beside each
// is what the engine finds in it, and tests/practice.test.js runs every one through detect() in English and
// Spanish, so a drill can't drift from what Clotr really does. Every value here is made up: 555-01xx phone
// numbers, example.com addresses, a test card number, invented streets. English is written here, and Spanish
// comes from _locales.
(() => {
  "use strict";

  const { msg } = globalThis.Clotr;

  // Checks whether a reply is a bare number, with nothing else around it, shaped like what the drill's own
  // message just asked for. A real chat has to stay quiet on a bare number alone, and detect() still does
  // here too, except for a bare 9 digits that happens to pass the SSN's own shape check. Since a drill already
  // asked for this number outright, the drill shows its own honest line instead of the usual "nothing found".
  function bareNumber(min, max) {
    return (text) => {
      const t = text.trim();
      if (!/^\d(?:[\s-]?\d)*$/.test(t)) return false;
      const n = t.replace(/[\s-]/g, "").length;
      return n >= min && n <= max;
    };
  }

  // `finds` is what detect() returns for the made-up reply, one entry per kind, with a scam code's reason
  // after a colon. Each safer reply and why line follows the source named in the comment beside it.
  const drills = [
    {
      id: "bank",
      who: msg("pd_d1Who", "“your bank”"),
      from: msg("pd_d1From", "Anytown Bank Fraud Team"),
      message: msg(
        "pd_d1Message",
        "Hello, this is the fraud team at Anytown Bank. We stopped a strange payment on your card. To cancel it, please tell me the 6-digit code we just texted you.",
      ),
      reply: msg("pd_d1Reply", "ok, the code they texted me is 482913"),
      finds: ["password:login_code"],
      // The FTC on verification codes ("Anyone who asks you for your account verification code is a scammer").
      safer: msg("pd_d1Safer", "I'll call the number on the back of my card myself."),
      why: msg("pd_d1Why", "You call them, on a number you already trust."),
      bareAsk: {
        shape: bareNumber(4, 8),
        sample: "482913",
        text: msg(
          "pd_d1Bare",
          "This looks like the code they just asked for. A real bank never asks you to read back a code it just texted you — that's always a scammer. But typed as a bare number, Clotr can't tell that from a harmless one in a real chat: it has to stay quiet. So catching this one was on you.",
        ),
      },
    },
    {
      id: "grandson",
      who: msg("pd_d2Who", "“your grandson”"),
      from: msg("pd_d2From", "Your grandson"),
      message: msg(
        "pd_d2Message",
        "Grandma, it's me. I'm in trouble and I can't tell Mom. Can you buy two gift cards, two hundred dollars each, and send me the numbers on the back? I'll pay you back, I promise.",
      ),
      reply: msg("pd_d2Reply", "the gift card code is 7KQ2-9PMX-4RT8 and the pin is 4471"),
      finds: ["gift_card"],
      // The FTC on family emergencies ("Use a phone number you know is theirs") and the FBI's family secret word.
      safer: msg("pd_d2Safer", "Call me from your own phone. I want to hear your voice first."),
      why: msg("pd_d2Why", "A real grandchild can call. The FBI also advises families to agree on a secret word."),
      bareAsk: {
        shape: bareNumber(3, 6),
        sample: "4471",
        text: msg(
          "pd_d2Bare",
          "This looks like the pin they just asked for. A real grandchild in trouble calls you — they don't ask you to read numbers off a gift card. But typed as a bare number, Clotr can't tell that from a harmless one in a real chat: it has to stay quiet. So catching this one was on you.",
        ),
      },
    },
    {
      id: "buyer",
      who: msg("pd_d3Who", "a bike buyer"),
      from: msg("pd_d3From", "Bike buyer"),
      message: msg(
        "pd_d3Message",
        "Hi, is the bike still for sale? Before I come, I need to check you're real. I'm sending you a code, just tell me what it says.",
      ),
      reply: msg("pd_d3Reply", "the verification code is 552019"),
      finds: ["password:login_code"],
      // The FTC on the Google Voice scam ("don't share your … verification code … with someone if you didn't contact
      // them first").
      safer: msg("pd_d3Safer", "No code needed. Cash when you pick it up."),
      why: msg(
        "pd_d3Why",
        "A buyer never needs a code from you. With one, a scammer can tie your phone number to an account of theirs.",
      ),
      bareAsk: {
        shape: bareNumber(4, 8),
        sample: "552019",
        text: msg(
          "pd_d3Bare",
          "This looks like the code they just asked for. A real buyer never needs a code from you — with one, a scammer can open an account in your name. But typed as a bare number, Clotr can't tell that from a harmless one in a real chat: it has to stay quiet. So catching this one was on you.",
        ),
      },
    },
    {
      id: "support",
      who: msg("pd_d4Who", "“tech support”"),
      from: msg("pd_d4From", "Computer Support Center"),
      message: msg(
        "pd_d4Message",
        "This is your computer's support team. Your computer sent us a virus alert. Install AnyDesk and tell me the 9-digit number on your screen so we can fix it.",
      ),
      reply: msg("pd_d4Reply", "my AnyDesk code is 666 197 342"),
      finds: ["password:remote_code"],
      // The FTC on tech support scams ("Legitimate tech companies won't contact you … to tell you there's a problem").
      safer: msg("pd_d4Safer", "I didn't ask for help. I'm hanging up."),
      why: msg("pd_d4Why", "Real tech companies don't call or message you about a problem with your computer."),
      bareAsk: {
        shape: bareNumber(6, 9),
        // Starts 666 on purpose: never a valid SSN shape, so this stays the drill's example of a bare
        // code that genuinely has to stay quiet.
        sample: "666197342",
        text: msg(
          "pd_d4Bare",
          "This looks like the number they just asked for. Real tech support doesn't call out of nowhere and ask you to read a number off your screen. But typed as a bare number, Clotr can't tell that from a harmless one in a real chat: it has to stay quiet. So catching this one was on you.",
        ),
      },
    },
    {
      id: "shop",
      who: msg("pd_d5Who", "“a shop”"),
      from: msg("pd_d5From", "Shop Example orders"),
      message: msg(
        "pd_d5Message",
        "Your order couldn't go through. To confirm it's you, reply with the 3 numbers on the back of your card within 1 hour.",
      ),
      reply: msg("pd_d5Reply", "the 3 numbers on the back are 482"),
      finds: ["card_code"],
      // Georgia's Attorney General ("credit card companies will never ask you to provide your 3-digit code").
      safer: msg("pd_d5Safer", "I'll check my order on the shop's own website."),
      why: msg(
        "pd_d5Why",
        "Your card company never asks for those numbers, and a shop needs them only on the checkout page you opened yourself.",
      ),
      bareAsk: {
        shape: bareNumber(3, 4),
        sample: "482",
        text: msg(
          "pd_d5Bare",
          "This looks like the numbers they just asked for. Your card company never asks for those numbers, and a shop only needs them on its own checkout page. But typed as a bare number, Clotr can't tell that from a harmless one in a real chat: it has to stay quiet. So catching this one was on you.",
        ),
      },
    },
    {
      id: "friend",
      who: msg("pd_d6Who", "a new friend in a game"),
      from: msg("pd_d6From", "A new friend from a game"),
      message: msg(
        "pd_d6Message",
        "you're so good at this game!! what's your address? I'll mail you a gift card for the skins",
      ),
      reply: msg("pd_d6Reply", "I live at 42 Maple Street"),
      finds: ["street_address"],
      // Plain advice, not a claim.
      safer: msg("pd_d6Safer", "I don't give my address to people I've only met online."),
      why: msg(
        "pd_d6Why",
        "Someone you've only met online doesn't need where you live. If they keep asking, tell an adult you trust.",
      ),
    },
  ];

  // Spot the leak's messages, each one typed into an AI chat. `finds` is the kinds detect() finds, empty for
  // half of them. `instead` only shows up for a message with something Bandage can't cover, like a password or
  // a key; the rest get Bandage's own line, drawn from whatever the engine finds.
  const leaks = [
    {
      id: "landlord",
      text: msg(
        "pd_l1",
        "Can you help me write to my landlord about the heating? I'm at 42 Maple Street, apartment 3, and my phone is 555-0142.",
      ),
      finds: ["phone_number", "street_address"],
    },
    {
      id: "wifi",
      text: msg("pd_l2", "Why won't my wifi connect? The password is Sunflower-2024 and the router is upstairs."),
      finds: ["password"],
      instead: msg("pd_l2Instead", "The AI doesn't need the password to help with the wifi: leave it out."),
    },
    {
      id: "neighbor",
      text: msg("pd_l3", "Write a polite reply to my neighbor and sign it with my email, jane.doe@example.com."),
      finds: ["email"],
    },
    {
      id: "gym",
      text: msg("pd_l4", "My card 4111 1111 1111 1111 was charged twice by the gym. Write me a complaint letter."),
      finds: ["credit_card"],
    },
    {
      id: "script",
      text: msg("pd_l5", "This script fails with a 403, here's my config: AWS_ACCESS_KEY_ID=AKIA4HPQ7XZ2R6TWLJ3N"),
      finds: ["aws_access_key"],
      instead: msg("pd_l5Instead", "The AI doesn't need the key to help: send the error without it."),
    },
    {
      id: "retirement",
      text: msg("pd_l6", "I was born on 14 March 1961. What should I know about retirement savings at my age?"),
      finds: ["date_of_birth"],
    },
    {
      id: "deposit",
      text: msg("pd_l7", "Help me fill in this direct deposit form: my account number is 1234567890."),
      finds: ["bank_account"],
    },
    {
      id: "tax",
      text: msg("pd_l8", "My tax form asks for my SSN, it's 219-09-9999, where does it go?"),
      finds: ["us_ssn"],
    },
    {
      id: "late",
      text: msg("pd_l9", "Text my friend Sam at (555) 555-0177 and tell him I'm running late."),
      finds: ["phone_number"],
    },
    {
      id: "delivery",
      text: msg("pd_l10", "Write a note for the delivery driver: leave it at 15 Birch Road, the blue door."),
      finds: ["street_address"],
    },
    {
      id: "code",
      text: msg("pd_l11", "My bank texted me this code: 482913. Is it real?"),
      finds: ["password:login_code"],
      instead: msg("pd_l11Instead", "Ask about the message without the code: the AI doesn't need it to help."),
    },
    {
      id: "cover",
      text: msg(
        "pd_l12",
        "Write a cover letter for me. My email is sam.lee@example.com and my number is (555) 555-0163.",
      ),
      finds: ["email", "phone_number"],
    },
    {
      id: "team",
      text: msg("pd_l13", "Can you make this email to my team sound friendlier? We moved the meeting to Thursday."),
      finds: [],
    },
    {
      id: "dinner",
      text: msg("pd_l14", "What's a good recipe for a quick dinner with chicken, rice and whatever vegetables I have?"),
      finds: [],
    },
    {
      id: "order",
      text: msg("pd_l15", "My order number is 112-4567890-1234567 and it hasn't arrived. Write a message to the shop."),
      finds: [],
    },
    {
      id: "savings",
      text: msg(
        "pd_l16",
        "Explain the difference between a savings account and a retirement plan like I'm new to this.",
      ),
      finds: [],
    },
    {
      id: "trip",
      text: msg("pd_l17", "Plan a three-day trip to Lisbon in May for two people who love museums."),
      finds: [],
    },
    {
      id: "meeting",
      text: msg("pd_l18", "The meeting is at 3:30 in room 214. Can you write a reminder for the team?"),
      finds: [],
    },
    {
      id: "scam",
      text: msg("pd_l19", "How do I tell if a text from my bank is real or a scam?"),
      finds: [],
    },
    {
      id: "birthday",
      text: msg(
        "pd_l20",
        "My grandson's birthday is next week and he loves dinosaurs. Gift ideas under thirty dollars?",
      ),
      finds: [],
    },
    {
      id: "grammar",
      text: msg("pd_l21", "Fix the grammar: their going to the store tomorrow at 9 to buy 12 eggs."),
      finds: [],
    },
    {
      id: "strong",
      text: msg("pd_l22", "What makes a password strong? Explain without giving me one."),
      finds: [],
    },
    {
      id: "translate",
      text: msg("pd_l23", "Translate into Spanish: The package will arrive between 2 and 4 pm."),
      finds: [],
    },
    {
      id: "score",
      text: msg("pd_l24", "Our team won 42 to 17 last night. Write a short cheer for the group chat."),
      finds: [],
    },
  ];

  // The labels Bandage would send in place of what the engine found, in the order they appear, using
  // content.js's own words for each kind and numbering repeats per kind. A birth year gets rounded down to its
  // decade, the same way content.js's bandageLabel() does in a real chat.
  const coverWords = {
    my_name: "bl_me",
    employer: "bl_company",
    family_name: "bl_family",
    street_address: "bl_address",
    phone_number: "bl_phone",
    email: "bl_email",
    date_of_birth: "bl_birth",
    credit_card: "bl_card",
    bank_account: "bl_account",
    public_ip: "bl_ip",
    watch_list: "bl_term",
  };
  const WORDS = {
    bl_me: msg("bl_me", "Me"),
    bl_company: msg("bl_company", "My company"),
    bl_family: msg("bl_family", "Family"),
    bl_address: msg("bl_address", "Address"),
    bl_phone: msg("bl_phone", "Phone"),
    bl_email: msg("bl_email", "Email"),
    bl_birth: msg("bl_birth", "Birth date"),
    bl_card: msg("bl_card", "Card"),
    bl_account: msg("bl_account", "Account"),
    bl_ip: msg("bl_ip", "IP address"),
    bl_term: msg("bl_term", "Term"),
    bl_id: msg("bl_id", "ID"),
  };
  function coverLabels(text, results) {
    const counts = {};
    return results
      .flatMap((r) => r.matches.map((m) => ({ r, m, at: text.indexOf(m) })))
      .sort((a, b) => a.at - b.at)
      .map(({ r, m }) => {
        const year = r.id === "date_of_birth" && m.match(/\b(19|20)\d\d\b/);
        if (year) return `[${msg("bl_bornIn", "born in the $1s", String(Math.floor(Number(year[0]) / 10) * 10))}]`;
        const kind = coverWords[r.id] || "bl_id";
        counts[kind] = (counts[kind] || 0) + 1;
        const alone = (r.id === "my_name" || r.id === "employer") && counts[kind] === 1;
        return alone ? `[${WORDS[kind]}]` : `[${WORDS[kind]} ${counts[kind]}]`;
      });
  }

  globalThis.Clotr = { ...globalThis.Clotr, practice: { drills, leaks, coverWords, coverLabels } };
})();
