import { describe, expect, it } from "vitest";
import { mentionsSelfHarm, restates } from "../components/flagship/oto-chat-text";

describe("mentionsSelfHarm", () => {
  it("catches a visitor saying they might hurt themselves", () => {
    for (const text of [
      "Honestly it's been a terrible week. Sometimes I think about hurting myself.",
      "I want to kill myself",
      "I've been having suicidal thoughts",
      "I don't want to live anymore",
      "I just want to die",
      "thinking about ending my life",
      "I've been cutting myself again",
      "everyone would be better off dead without me",
    ]) {
      expect(mentionsSelfHarm(text), text).toBe(true);
    }
  });

  it("leaves car talk alone", () => {
    for (const text of [
      "These brake bills are killing me",
      "My car died on the highway and I'm stuck",
      "The battery is dead",
      "I don't want to be here all day waiting for an oil change",
      "Can the shop cut me a deal on tires?",
      "My engine is dying when I stop at lights",
    ]) {
      expect(mentionsSelfHarm(text), text).toBe(false);
    }
  });
});

// Consecutive Oto bubbles captured verbatim from the live site chat on
// 2026-09-14 (scripts/oto/qa.mjs). The released-vs-kept pair is written for
// the test.
describe("restates", () => {
  it("catches a reply the agent gave twice in different words", () => {
    // "Does a timing belt replacement include the water pump?"
    expect(
      restates(
        "No, a timing belt replacement includes the belt, tensioner, and idler pulleys. The water pump is not listed as included.",
        "A timing belt replacement with Otopair includes the belt, tensioner, and idler pulleys. The water pump is not part of that service."
      )
    ).toBe(true);
    // "My ABS light is on. Does that mean I need new brake pads?"
    expect(
      restates(
        "That's a good question. An ABS or brake light doesn't always mean you need new brake pads. It could be a few things, like low brake fluid, worn pads, or even a sensor issue.",
        "Not necessarily. An ABS or brake light can come from low brake fluid, worn pads, or a sensor fault, among other things. If the light is red, it's best to stop somewhere safe and have your car towed. If it's amber, you should get it inspected before you drive it again. A shop will be able to confirm the exact cause."
      )
    ).toBe(true);
    // "If the shop finds more wrong once my car is on the lift, can they just add it to my bill?"
    expect(
      restates(
        "No, they can't. If the shop finds more work, they send you a request in the app with the added work and its price. You have 24 hours to approve or decline it. If you decline, that work is never charged, and the shop only completes what you originally booked.",
        "That's a really important question, and it's one of the main reasons Otopair works the way it does. No, a shop can't just add more to your bill. If they find anything else your car needs, they have to send you a request in the app with the details and the new price. You then have 24 hours to approve or decline that extra work. If you decline it, you're only charged for what you originally approved."
      )
    ).toBe(true);
  });

  it("keeps two bubbles that say different things about the same topic", () => {
    // "Can I book an oil change right now?" — a disclaimer, then how it works.
    expect(
      restates(
        "I can show you how booking an oil change works in the app, but I can't book a real one for you here. This is a demo of the Otopair website.",
        "An oil change is one of the services you can book through Otopair. In the app, you'd tell Oto you need an oil change, and it would show you every verified shop's price for your exact car. You pick the shop and time that works for you."
      )
    ).toBe(false);
    // "What's the difference between a diagnostic scan and a check engine light diagnosis?"
    expect(
      restates(
        "A Diagnostic Scan reads your car's trouble codes to give you a clearer picture of what might be going on. It's a good first step when a warning light is on and you want to know what the car is reporting.",
        "A Check Engine Light Diagnosis is a bit more in-depth. It also reads the code, but then a mechanic works to find the root cause of why the light came on. This helps you know exactly what repair to book next."
      )
    ).toBe(false);
    // A contrast that shares its key phrase: released vs kept.
    expect(
      restates(
        "The $20 hold is released in full if you cancel 24 hours or more before your appointment.",
        "Inside 24 hours, the $20 hold is kept as a late-cancellation fee, never more than $20."
      )
    ).toBe(false);
  });

  it("never merges short replies, which can't be told apart reliably", () => {
    expect(restates("Brooklyn is planned for Q4 2026.", "Queens is planned for Q1 2027.")).toBe(false);
    expect(restates("Yes.", "Yes.")).toBe(false);
  });
});
