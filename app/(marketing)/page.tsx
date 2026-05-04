"use client";

import { BorderBeam } from "@/components/ui/border-beam";
import { Marquee } from "@/components/ui/marquee";
import { useEffect, useState, useRef } from "react";
import Image from "next/image";
import { Wrench, X, CheckCircle2 } from "lucide-react";
import TransBar, { TransBarTwo } from "@/components/trans-bar";
import OurVision from "@/components/our-vision";
import Flow from "@/components/Flow";
import Coordination from "@/components/coordination";
import { motion, useScroll, useTransform, useMotionValue, useMotionValueEvent, AnimatePresence } from "motion/react";
import { TypingAnimation } from "@/components/ui/typing-animation";
import BlogSection from "@/components/blog-section";
import CoordinationPlax from "@/components/coordination-plax";
import { ChevronMarqueeButton } from "@/components/ui/chevron-marquee-button";
import TextAnimation from "@/components/ui/scroll-text";

const text = [
  "Booking a mechanic is now as easy as ordering takeout",
  "•",
  "See real prices, availability, and reviews instantly.",
  "•",
  "No phone calls, no back-and-forth, no guessing.",
  "•",
  "AI matches your car with the perfect mechanic.",
  "•",
  "Book in minutes, pay once, receipts forever.",
  "•"
]

const endtoend = [
  'bookings',
  'payments',
  'pickups',
  'reminders',
  'diagnostics',
  'receipts',
  'scheduling',
  'coordinating'
]
export default function Home() {

  const [isDark, setIsDark] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [showThankYou, setShowThankYou] = useState(false);
  const heroSectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const updateTheme = () => {
      setIsDark(document.documentElement.classList.contains("dark"));
    };

    updateTheme();

    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => observer.disconnect();
  }, []);

  // Track scroll progress through Hero section
  // Account for aspect ratio - section height is determined by aspectRatio: "1553/1450"
  // Track from when section enters viewport to when section end reaches viewport top (TransBar appears)
  const { scrollYProgress } = useScroll({
    target: heroSectionRef,
    offset: ["start start", "end start"] // Track from start to when section end reaches viewport top
  });

  // Transform scroll progress to create smooth scrolling for the card
  // Card scrolls down smoothly as user scrolls through hero section
  // When scroll progress reaches 1, card stops moving and stays fixed
  // Use negative values to move down (positive y moves down in CSS)
  const cardYOffset = useTransform(
    scrollYProgress,
    [0, 1],
    [0, 150], // Moves down 150px as you scroll through hero section
    { clamp: true }
  );

  // Opacity: keep card visible throughout
  const cardOpacity = useTransform(
    scrollYProgress,
    [0, 1],
    [1, 1], // Stay fully visible
    { clamp: true }
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const response = await fetch('/api/waitlist', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, name: name || undefined }),
      });

      const data = await response.json();

      if (response.ok) {
        setSubmitted(true);
        setShowThankYou(true);
        setName("");
        setEmail("");
      } else {
        console.error('Error:', data.error);
        alert(data.error || 'Failed to join waitlist. Please try again.');
      }
    } catch (error) {
      console.error('Error submitting form:', error);
      alert('Failed to join waitlist. Please try again.');
    }
  };



  return (
    <main className="min-h-screen w-full bg-white">
      <section
        ref={heroSectionRef}
        className="relative w-full overflow-hidden flex-1 xl:h-[125vh] h-screen sm:h-[900px]"
        style={{
          // minHeight: '100vh'
        }}
      >
        <div className="relative w-full xl:h-[125vh] h-screen sm:h-[900px]"
          style={{

          }}
        >
          <Image
            src="/home27.png"
            alt="Cityscape background"
            fill
            priority
            quality={100}
            className="w-full h-full object-cover sm:object-top object-center scale-100"
          />
        </div>

        <div
          className="absolute inset-0 w-full h-full backdrop-blur-[2px]"
          style={{
            background: "linear-gradient(to bottom, rgba(30,30,32,0.2) 80%, transparent 120%)"
          }}
        />
        {/* text-transparent bg-linear-to-r bg-clip-text  from-[#f9f9f9] via-50% to-[#0d72ff] */}
        {/* bg-linear-to-t px-1 from-[#f9f9f9] to-[#0d72ff] bg-clip-text text-transparent text-shadow */}
        <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20 flex flex-col items-center w-full px-4">
          <div className=" relative pt-8 flex flex-col items-center justify-center">
            <div className="flex flex-row items-center justify-center gap-x-4">
              <p
                className="pointer-events-none w-fit text-white xl:text-9xl sm:text-6xl text-6xl leading-none font-semibold "
                style={{
                  textShadow: '0 0 4.978px rgba(255, 255, 255, 0.80)',
                  fontFamily: "var(--font-Jersey_20)",
                }}
              >
                OTOPAIR
              </p>
            </div>

            <p className="text-center text-sm sm:text-base lg:text-xl leading-relaxed mb-6 text-white/90 px-4 w-full sm:max-w-2xl max-w-sm font-light tracking-wide  py-4">
              Welcome to the new age of car care and repairs. Where AI meets automotive expertise to deliver seamless, transparent, and intelligent service coordination.
            </p>

            {/* <p className="text-center text-sm lg:text-base leading-tight mb-3 text-[#E4E4E4] backdrop-blur-[0px] px-4 py-4 [mask-composite:intersect] [mask-image:linear-gradient(to_right,transparent,black_1rem),linear-gradient(to_left,transparent,black_1rem),linear-gradient(to_top,transparent,black_1rem),linear-gradient(to_bottom,transparent,black_1rem)] ">
              Receive all the latest news and updates,<br />as well as early access to the beta.
            </p> */}

            <form onSubmit={handleSubmit} className="flex flex-row items-center justify-center mt-6 gap-4 w-full">
              <div className="relative sm:w-82 w-fit h-full flex gap-4">
                <svg style={{ display: 'none' }}>
                  <filter id="displacementFilter">
                    <feTurbulence
                      type="turbulence"
                      baseFrequency="0.08"
                      numOctaves="8"
                      result="turbulence"
                    />
                    <feDisplacementMap
                      in="SourceGraphic"
                      in2="turbulence"
                      scale="200"
                      xChannelSelector="R"
                      yChannelSelector="G"
                    />
                  </filter>
                </svg>

                <div
                  className="absolute inset-0 w-full h-full rounded-2xl overflow-hidden"
                  style={{
                    filter: 'drop-shadow(-8px -10px 46px #0000005f)',
                    backdropFilter: 'brightness(1.1) blur(2px)',
                    border: '1px solid rgba(255, 255, 255, 0.7)',
                  }}
                >
                  <div
                    className="absolute inset-0 rounded-2xl"
                    style={{
                      boxShadow: 'inset 6px 6px 0px -6px rgba(255, 255, 255, 0.7), inset 0 0 8px 1px rgba(255, 255, 255, 0.7)',
                    }}
                  />
                </div>
                <input
                  type="email"
                  placeholder="Enter your email"
                  className="sm:px-5 px-4 sm:py-3 py-2 rounded-2xl relative z-20 text-white shadow-lg focus:outline-none focus:ring-2 focus:ring-gray-50 w-full  sm:text-lg text-base placeholder-gray-100 flex-1"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  disabled={submitted}
                  style={{ background: "transparent", fontSize: "16px" }}
                />
              </div>
              <div className="relative w-fit z-20 h-full flex items-center ml-2">
                <div
                  className="absolute inset-0 w-full h-full rounded-2xl overflow-hidden"
                  style={{
                    filter: 'drop-shadow(-8px -10px 50px #0000005f)',
                    backdropFilter: 'brightness(1.1) blur(2px)',
                    border: '1px solid rgba(255, 255, 255, 0.5)',
                  }}
                >
                  <div
                    className="absolute inset-0 rounded-2xl"
                    style={{
                      boxShadow: 'inset 6px 6px 0px -6px rgba(255, 255, 255, 0.7), inset 0 0 8px 1px rgba(255, 255, 255, 0.7)',
                    }}
                  />
                </div>
                <button
                  type="submit"
                  className="sm:px-8 px-4 sm:py-3 py-2 rounded-2xl text-white font-semibold sm:text-lg text-sm shadow-md transition disabled:opacity-50 disabled:cursor-not-allowed bg-blue-500 hover:bg-blue-600 hover:cursor-pointer relative z-20"
                  style={{ backdropFilter: "brightness(1.1) blur(15px)" }}
                  disabled={submitted || !email}
                >
                  {submitted ? "Submitted!" : "Join Waitlist"}
                </button>
              </div>
            </form>



            <div className="border-b py-4 h-3 p-2 sm:w-[30%] w-[15%] relative self-center my-4" />
            {/* <p className="text-sm lg:text-base leading-relaxed text-[#E4E4E4] mt-6">Powered By</p> */}
            <Marquee className="sm:w-[30%] w-[20%] backdrop-blur-sm rounded-lg py-3 [mask-composite:intersect] [mask-image:linear-gradient(to_right,transparent,black_6rem),linear-gradient(to_left,transparent,black_6rem)] space-x-2 flex flex-row">
              {
                text.map((item, i) => (
                  <p key={i} className="text-xs leading-relaxed text-[#E4E4E4]">{item}</p>
                ))
              }
            </Marquee>
          </div>

          {/* <div className="border-b py-4 h-3 p-2 w-[40%] relative" />
          <p className="lg:text-2xl mb-3 text-gray-300 my-4 z-10 font-af font-medium text-lg tracking-[-0.15px] leading-relaxed">Powered By</p>
          <Marquee className="w-[25%] backdrop-blur-sm rounded-lg py-3 [mask-composite:intersect] [mask-image:linear-gradient(to_right,transparent,black_6rem),linear-gradient(to_left,transparent,black_6rem)] space-x-4 flex flex-row">
            {
              IconsArray.map((item) => (
                <div key={item.name} className="grayscale"><item.icon className="h-8 w-8 " /></div>
              ))
            }
          </Marquee> */}
        </div>


        <motion.div
          className='p-3 absolute sm:left-8 left-1/2 -translate-x-1/2 sm:translate-x-0  bottom-12 rounded-2xl backdrop-blur-[15px] border border-white/20 shadow-[0_2px_6px_0_rgba(0,0,0,0.15)] bg-linear-to-r from-black/12 via-black/7 to-black/7 bg-clip-padding xl:max-w-[500px] sm:max-w-[300px] lg:max-w-md w-[90%] z-30'
          style={{
            y: cardYOffset.get() * 10,
            opacity: cardOpacity,
          }}
        >
          <div className="relative z-10 p-4  text-white rounded-2xl flex flex-col ">
            <h2 className='font-medium lg:text-4xl sm:text-xl md:text-3xl text-2xl leading-[120%] md:leading-10 tracking-[-0.44px] sm:tracking-[-0.56px] xl:tracking-[-0.8px] text-white max-w-[25ch] text-left mb-2'
              style={{ fontFamily: "var(--font-Jersey_20)" }}
            >AI That runs car care autonomously </h2>
            <p className='sm:text-sm text-xs xl:text-base leading-relaxed my-4 tracking-wider'>
              Book faster, pay once, get receipts forever.
              Shops get predictable calendars. Get your time back.
            </p>

            <div className="relative flex gap-x-3">
              <p className="underline text-white sm:text-sm text-xs inline-flex items-center gap-2 underline-offset-4 group">
                Get to know us
              </p>
              <ChevronMarqueeButton />
            </div>
          </div>
        </motion.div>

        <div className="absolute bottom-8 right-8 z-10 p-5 xl:p-8 xl:pr-6 text-white sm:block hidden">
          <div className="w-full flex justify-end pr-6"><Wrench className="w-8 h-8 mb-4 rotate-280 self-end flex" /></div>
          <p className='text-sm xl:text-base leading-relaxed mb-3 tracking-wider '
            style={{ fontFamily: "var(--font-Jersey_20)" }}
          >
            Agentic auto service is on the
            horizon, <br />and we’re deploying it bay by bay.
          </p>
        </div>
      </section >

      {/* Thank You Popup */}
      <AnimatePresence>
        {showThankYou && (
          <>
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="fixed inset-0 bg-black/60 backdrop-blur-md z-[300]"
              onClick={() => setShowThankYou(false)}
            />

            {/* Modal */}
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              transition={{
                duration: 0.4,
                ease: [0.25, 0.1, 0.25, 1]
              }}
              className="fixed inset-0 z-[301] flex items-center justify-center p-4 pointer-events-none"
            >
              <div
                className="relative w-full max-w-md pointer-events-auto"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Glassmorphism Container */}
                <div
                  className="relative rounded-3xl overflow-hidden"
                  style={{
                    background: 'linear-gradient(135deg, rgba(255, 255, 255, 0.98) 0%, rgba(255, 255, 255, 0.95) 100%)',
                    backdropFilter: 'blur(20px)',
                    border: '1px solid rgba(255, 255, 255, 0.4)',
                    boxShadow: '0 25px 70px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.2) inset',
                  }}
                >
                  {/* Inner glow */}
                  <div
                    className="absolute inset-0 rounded-3xl"
                    style={{
                      boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.7), inset 0 -1px 0 rgba(255, 255, 255, 0.5)',
                    }}
                  />

                  {/* Content */}
                  <div className="relative z-10 p-10">
                    {/* Close Button */}
                    <button
                      onClick={() => setShowThankYou(false)}
                      className="absolute top-6 right-6 p-2 rounded-lg hover:bg-gray-100/70 transition-colors"
                      aria-label="Close"
                    >
                      <X className="w-5 h-5 text-gray-600" />
                    </button>

                    {/* Success Icon with Animation */}
                    <div className="flex justify-center mb-6">
                      <motion.div
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        transition={{
                          delay: 0.2,
                          type: "spring",
                          stiffness: 200,
                          damping: 15
                        }}
                        className="relative"
                      >
                        <motion.div
                          initial={{ scale: 0, rotate: -180 }}
                          animate={{ scale: 1, rotate: 0 }}
                          transition={{
                            delay: 0.3,
                            type: "spring",
                            stiffness: 150,
                            damping: 12
                          }}
                          className="w-20 h-20 rounded-full bg-linear-to-br from-green-400 to-green-600 flex items-center justify-center shadow-lg"
                          style={{
                            boxShadow: '0 10px 30px rgba(34, 197, 94, 0.4)',
                          }}
                        >
                          <CheckCircle2 className="w-12 h-12 text-white" />
                        </motion.div>
                        {/* Ripple effect */}
                        <motion.div
                          initial={{ scale: 0, opacity: 0.6 }}
                          animate={{ scale: 2, opacity: 0 }}
                          transition={{
                            delay: 0.5,
                            duration: 0.8,
                            repeat: Infinity,
                            repeatDelay: 2
                          }}
                          className="absolute inset-0 rounded-full bg-green-500"
                        />
                      </motion.div>
                    </div>

                    {/* Title with fade-in */}
                    <motion.h2
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.4, duration: 0.4 }}
                      className="text-3xl font-semibold text-center text-gray-900 mb-3 tracking-tight"
                    >
                      You're In! 🎉
                    </motion.h2>

                    <motion.p
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.5, duration: 0.4 }}
                      className="text-center text-gray-600 mb-8 text-sm leading-relaxed"
                    >
                      Thank you for joining the Otopair waitlist!<br />
                      Check your email for confirmation and exclusive updates.
                    </motion.p>

                    {/* Logo */}
                    <motion.div
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ delay: 0.6, duration: 0.4 }}
                      className="flex justify-center mb-6"
                    >
                      <div className="relative w-16 h-16">
                        <Image src="/logo.png" alt="Otopair Logo" fill className="object-cover" />
                      </div>
                    </motion.div>

                    {/* Company Info */}
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.7, duration: 0.4 }}
                      className="text-center mb-6"
                    >
                      <p className="text-lg font-semibold text-gray-900 mb-1">Otopair</p>
                      <p className="text-sm text-gray-600">
                        The future of car repair coordination
                      </p>
                    </motion.div>

                    {/* Social Links */}
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.8, duration: 0.4 }}
                      className="flex items-center justify-center gap-3 mb-6"
                    >
                      <a
                        href="https://www.linkedin.com/company/repair-connect/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-12 h-12 rounded-xl border border-gray-200 flex items-center justify-center hover:bg-gray-50 transition-all hover:scale-110 hover:shadow-md"
                        aria-label="LinkedIn"
                      >
                        <svg className="w-6 h-6 text-gray-700" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
                        </svg>
                      </a>
                      <a
                        href="https://twitter.com"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-12 h-12 rounded-xl border border-gray-200 flex items-center justify-center hover:bg-gray-50 transition-all hover:scale-110 hover:shadow-md"
                        aria-label="Twitter"
                      >
                        <svg className="w-6 h-6 text-gray-700" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                        </svg>
                      </a>
                    </motion.div>

                    {/* Close Button */}
                    <motion.button
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: 0.9, duration: 0.4 }}
                      onClick={() => setShowThankYou(false)}
                      className="w-full px-6 py-3 rounded-xl font-semibold text-gray-700 bg-gray-100 hover:bg-gray-200 transition-colors"
                    >
                      Close
                    </motion.button>
                  </div>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <TransBar />


      <OurVision />
      <TransBarTwo />
      <Flow />
      <div className="rotate-180"><TransBarTwo /></div>
      <div className='w-full lg:hidden flex items-center justify-center '>
        <div className="w-full flex items-start flex-col justify-end xl:h-[70%] h-[50%] px-8 gap-y-8">
          <div className="space-y-6 flex flex-col">
            <TextAnimation
              text="You need clarity before you drive over."
              direction="left"
              classname="text-2xl sm:text-4xl lg:text-3xl text-neutral-900 "
            />
            <TextAnimation
              text="You need confidence when you hand over the keys."
              direction="left"
              classname="text-2xl sm:text-4xl lg:text-3xl text-neutral-900"
            />
            <TextAnimation
              text="You need coordination."
              direction="left"
              classname="text-2xl sm:text-4xl lg:text-3xl text-neutral-900"
            />
          </div>

        </div>
      </div>
      <CoordinationPlax />
      <BlogSection />

    </main >
  );
}
