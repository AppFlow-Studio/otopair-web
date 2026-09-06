"use client";

import { Plate } from "@/components/flagship/product/device";
import { AnswerPull, SourcesFan, VoicePull } from "@/components/flagship/product/pullouts";
import { BRAKES, ChatScreen, OtoTurn, QuickReplies, ThinkingTurn, UserBubble } from "@/components/flagship/product/screens/chat";
import { RecordScreen } from "@/components/flagship/product/screens/record";
import { MyCarsScreen } from "@/components/flagship/product/screens/cars";
import { PhoneAt, Rise, SectionHead } from "../pricing/sections";

/**
 * /oto sections. Three compositions:
 *  1. Two phones on one sky plate: the voice bar mid-sentence, and the
 *     "Reading your car" state with the sources ticking off. The voice bar
 *     is lifted out beneath, big.
 *  2. No device: one answer as prose beside the three source cards, fanned.
 *  3. The record: the confirm card in the chat and the My Cars screen it
 *     feeds, on a paper plate.
 */
export function OtoSections() {
  return (
    <>
      {/* 1 · talk to it */}
      <section className="pb-16 tab:pb-24">
        <SectionHead id="talk" title="Talk to it like a person." line="Say what the car is doing, in your words, by voice or by text. Oto asks one narrowing question, not twenty." />
        <Plate className="relative mt-10 tab:mt-14" clip>
          <div className="flex flex-col items-center gap-8 px-6 pt-10 tab:flex-row tab:items-end tab:justify-center tab:gap-14 tab:px-14 tab:pt-16">
            <Rise className="-mb-[28%] tab:-mb-[10%]">
              <PhoneAt w={310}>
                <ChatScreen input="voice">
                  <UserBubble>{BRAKES.user}</UserBubble>
                  <OtoTurn>{BRAKES.question}</OtoTurn>
                  <QuickReplies items={BRAKES.chips} />
                </ChatScreen>
              </PhoneAt>
            </Rise>
            <Rise delay={0.12} className="-mb-[28%] tab:-mb-[18%]">
              <PhoneAt w={310}>
                <ChatScreen input="none">
                  <UserBubble>There is a grinding noise when I turn left at low speed.</UserBubble>
                  <ThinkingTurn done={2} />
                </ChatScreen>
              </PhoneAt>
            </Rise>
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[38%] bg-[linear-gradient(to_top,#ffffff_20%,rgba(255,255,255,0))]" aria-hidden />
          <div className="absolute inset-x-6 bottom-8 flex justify-center tab:inset-x-14 tab:bottom-12">
            <VoicePull />
          </div>
        </Plate>
        <p className="mt-6 max-w-[60ch] text-[15.5px] leading-[1.55] text-[#4c5661]">Hold the button and describe it out loud, or type. While you wait, Oto pulls the records for your exact car: your service history, the manufacturer&apos;s data for your VIN, and any stored codes.</p>
      </section>

      {/* 2 · it shows its work */}
      <section className="py-16 tab:py-24">
        <SectionHead id="sources" title="It shows its work." line="Every answer cites what it checked: your service history, the manufacturer's data for your VIN, the code dictionary. Then a shop confirms." />
        <div className="mt-10 grid items-start gap-8 tab:mt-14 tab:grid-cols-12 tab:gap-10">
          <div className="tab:col-span-7">
            <AnswerPull />
            <p className="mt-5 max-w-[56ch] text-[15.5px] leading-[1.55] text-[#4c5661]">Oto scopes and explains. It never claims a diagnosis; the shop confirms the work with the car in front of them, and nothing is charged before that.</p>
          </div>
          <div className="tab:col-span-5 tab:pt-6">
            <SourcesFan />
          </div>
        </div>
      </section>

      {/* 3 · the record */}
      <section className="py-16 tab:py-24">
        <SectionHead id="record" title="It keeps your car's record." line="Mileage, warning lights and services done elsewhere go in with a confirm card, and feed your Vehicle Health Score." />
        <Plate tone="paper" className="relative mt-10 tab:mt-14" clip>
          <div className="flex flex-col items-center gap-8 px-6 pt-10 tab:flex-row tab:items-end tab:justify-center tab:gap-16 tab:px-14 tab:pt-16">
            <Rise className="-mb-[28%] tab:-mb-[12%]">
              <PhoneAt w={310}>
                <RecordScreen state="ask" />
              </PhoneAt>
            </Rise>
            <Rise delay={0.12} className="-mb-[28%] tab:-mb-[22%]">
              <PhoneAt w={310}>
                <MyCarsScreen score={81} />
              </PhoneAt>
            </Rise>
          </div>
        </Plate>
        <p className="mt-6 max-w-[60ch] text-[15.5px] leading-[1.55] text-[#4c5661]">Nothing is written to your car until you confirm. Once it is on the record, the Maintenance Tracker and the score move with it, and the next shop sees it too.</p>
      </section>
    </>
  );
}
