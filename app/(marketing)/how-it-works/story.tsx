"use client";

import { Walkthrough, type WalkStep } from "@/components/flagship/product/walkthrough";
import { BRAKES, ChatScreen, OtoTurn, QuickReplies, Sources, UserBubble } from "@/components/flagship/product/screens/chat";
import { BookShopsScreen } from "@/components/flagship/product/screens/book";
import { ReviewPayScreen } from "@/components/flagship/product/screens/pay";
import { ApproveEstimateScreen, BookingsScreen, ReceiptScreen } from "@/components/flagship/product/screens/bookings";

/**
 * The seven steps and the screen each one shows. Client component only so
 * the page can stay a server component with its metadata export.
 *
 * Motion (docs/design/motion.md): nothing to add here. The order of these
 * steps IS the motion, and Walkthrough already choreographs it — one
 * observer per step drives the pinned phone's 320ms screen crossfade, the
 * spring rail dot and the active step's body. Do not wrap this in a Reveal
 * or a Sequence: a second entrance would double-animate a component that
 * already animates, and a transform on the wrapper would drag the pinned
 * column with it.
 */
const STEPS: WalkStep[] = [
  {
    id: "tell-oto",
    title: "Tell Oto what the car is doing.",
    body: "Say it the way you would to a friend, by voice or by text. No service menu, no form. Oto asks one narrowing question, not twenty.",
    screen: (
      <ChatScreen input="voice">
        <UserBubble>{BRAKES.user}</UserBubble>
        <OtoTurn>{BRAKES.question}</OtoTurn>
        <QuickReplies items={BRAKES.chips} on={BRAKES.chips[0]} />
      </ChatScreen>
    ),
  },
  {
    id: "scoped",
    title: "Oto scopes the job and reads your car from its VIN.",
    body: "It checks your service history, the manufacturer's data for your exact car and any stored codes, then names the job a shop can price. A guide, not a diagnosis.",
    screen: (
      <ChatScreen input="idle" animate={false}>
        <UserBubble>{BRAKES.user}</UserBubble>
        <OtoTurn>{BRAKES.answer}</OtoTurn>
        <Sources />
        <QuickReplies items={BRAKES.next} on={BRAKES.next[0]} />
      </ChatScreen>
    ),
  },
  {
    id: "shops",
    title: "Every verified shop shows its total for your car.",
    body: "Shops set their own prices. You see the full amount each one would charge for this job on this car, side by side, before you pick.",
    screen: <BookShopsScreen picked={0} />,
  },
  {
    id: "book",
    title: "Book & Pay places a $20 hold. Nothing more.",
    body: "The total you confirm is the most you will pay. Your card carries a $20 authorization to reserve the slot, and it stays there until the shop has seen the car.",
    screen: <ReviewPayScreen compact />,
  },
  {
    id: "confirm",
    title: "The shop inspects the car and confirms the estimate.",
    body: "Within what you approved, it confirms on its own and the booking moves along. You watch it happen from the Bookings tab.",
    screen: <BookingsScreen stage={1} title="Estimate confirmed, $312" subtitle="Within what you approved" />,
  },
  {
    id: "approve",
    title: "Anything extra needs your yes.",
    body: "If the shop finds more once the car is on the lift, the added work and its price come to you in the app. You have 24 hours to answer. Declined work is never charged.",
    screen: <ApproveEstimateScreen />,
  },
  {
    id: "pay",
    title: "You are charged when the job is marked complete.",
    body: "The receipt shows what happened to your hold at every stage and the parts that went in. Then you review the shop, once, on a booking that actually happened.",
    screen: <ReceiptScreen />,
  },
];

export default function HowItWorksStory() {
  return <Walkthrough steps={STEPS} />;
}
