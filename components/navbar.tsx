'use client'
import Link from 'next/link'
import Image from 'next/image'
import React, { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { AnimatedThemeToggler } from './ui/animated-theme-toggler'
import LiquidGlass from '@nkzw/liquid-glass'
import { ChevronRight, Menu, X, CheckCircle2 } from 'lucide-react'
import { usePathname } from 'next/navigation'
const navItems = [
    {
        label: 'About',
        href: '/'
    },
    {
        label: 'Careers',
        href: '/careers'
    },
    {
        label: 'Services',
        href: '/services'
    }
]
function Navbar() {
    const pathname = usePathname()
    const [scrolled, setScrolled] = useState(false)
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
    const [waitlistModalOpen, setWaitlistModalOpen] = useState(false)
    const [email, setEmail] = useState('')
    const [name, setName] = useState('')
    const [submitted, setSubmitted] = useState(false)
    const isHome = pathname === "/"

    useEffect(() => {
        if (!isHome) {
            setScrolled(true)
            return
        }
        const onScroll = () => {
            const threshold = typeof window !== 'undefined' ? window.innerHeight * 0.85 : 0
            setScrolled(window.scrollY > threshold)
        }
        onScroll()
        window.addEventListener('scroll', onScroll, { passive: true })
        return () => window.removeEventListener('scroll', onScroll)
    }, [isHome])

    const handleWaitlistSubmit = async (e: React.FormEvent) => {
        e.preventDefault()

        try {
            const response = await fetch('/api/waitlist', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ email, name: name || undefined }),
            })

            const data = await response.json()

            if (response.ok) {
                setSubmitted(true)
                setTimeout(() => {
                    setSubmitted(false)
                    setName("")
                    setEmail("")
                    setWaitlistModalOpen(false)
                }, 2000)
            } else {
                console.error('Error:', data.error)
                alert(data.error || 'Failed to join waitlist. Please try again.')
            }
        } catch (error) {
            console.error('Error submitting form:', error)
            alert('Failed to join waitlist. Please try again.')
        }
    }
    return (
        <>
            <div className='fixed lg:top-4 lg:left-1/2 lg:-translate-x-1/2 z-[112] w-full lg:max-w-fit mx-auto lg:rounded-[12px] transition-all duration-[250ms] ease-[cubic-bezier(0.4,0,0.2,1)] will-change-[background-color,border-color,box-shadow,backdrop-filter] lg:border border-white/20 bg-gradient-to-r from-[rgba(249,250,247,0.12)] to-[rgba(249,250,247,0.18)] lg:shadow-[0_2px_6px_0_rgba(0,0,0,0.15)] backdrop-blur-[9px]'>
                <main className='flex gap-6 items-center px-5 py-3 lg:px-3 lg:py-2 w-full justify-between'>
                    <Link href='/' className='flex self-center sm:w-12 w-10 sm:h-12 h-10 relative '><Image src="/logo.png" alt="Otopair Hero" fill className="object-cover" /></Link>

                    {/* Desktop Navigation - hidden on mobile */}
                    <div className='hidden lg:flex gap-6 items-center'>
                        {
                            navItems.map((item) => (
                                <Link key={item.href} href={item.href} className={`font-medium sm:text-[15px] text-[12px] leading-[140%] tracking-[-0.15px] hover:opacity-80 transition-all duration-[250ms] ease-[cubic-bezier(0.4,0,0.2,1)] font-af ${!scrolled ? 'text-white' : 'text-black'} transition-all duration-[250ms] ease-[cubic-bezier(0.4,0,0.2,1)]`}>
                                    {item.label}
                                </Link>
                            ))
                        }
                        <Link
                            href="/dashboard"
                            className={`font-medium sm:text-[15px] text-[12px] leading-[140%] tracking-[-0.15px] hover:opacity-80 transition-all duration-[250ms] ease-[cubic-bezier(0.4,0,0.2,1)] font-af ${!scrolled ? 'text-white' : 'text-black'} transition-all duration-[250ms] ease-[cubic-bezier(0.4,0,0.2,1)]`}
                        >
                            Shop Sign-In
                        </Link>
                    </div>

                    <div className='flex flex-row items-center gap-2'>
                        {/* Desktop Button - hidden on mobile */}
                        <motion.button
                            onClick={() => setWaitlistModalOpen(true)}
                            className="block relative px-5 py-2 rounded-lg font-medium sm:text-sm text-xs text-white overflow-hidden group"
                            style={{
                                background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.8) 0%, rgba(37, 99, 235, 0.9) 100%)',
                                boxShadow: '0 4px 14px 0 rgba(59, 130, 246, 0.3)',
                            }}
                            whileHover={{
                                scale: 1.05,
                                boxShadow: '0 6px 20px 0 rgba(59, 130, 246, 0.4)',
                            }}
                            whileTap={{ scale: 0.98 }}
                            transition={{
                                type: "spring",
                                stiffness: 400,
                                damping: 17
                            }}
                        >
                            {/* Shimmer effect */}
                            <motion.div
                                className="absolute inset-0"
                                style={{
                                    background: 'linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.3), transparent)',
                                }}
                                animate={{
                                    x: ['-100%', '200%'],
                                }}
                                transition={{
                                    duration: 2,
                                    repeat: Infinity,
                                    repeatDelay: 1,
                                    ease: 'linear',
                                }}
                            />
                            {/* Button text */}
                            <span className="relative z-10 tracking-[-0.15px] inline-flex sm:text-base text-xs items-center gap-2">
                                Join Waitlist <ChevronRight className='w-4 h-4' />
                            </span>
                        </motion.button>

                        {/* Mobile Hamburger Button */}
                        <button
                            onClick={() => setMobileMenuOpen(true)}
                            className="lg:hidden p-2 rounded-lg transition-all duration-200 hover:bg-white/10"
                            aria-label="Open menu"
                        >
                            <Menu className={`w-6 h-6 transition-colors ${!scrolled ? 'text-white' : 'text-black'}`} />
                        </button>
                    </div>
                </main>
            </div>

            {/* Mobile Full Screen Menu */}
            <AnimatePresence>
                {mobileMenuOpen && (
                    <>
                        {/* Full Screen Menu */}
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.3 }}
                            className="fixed inset-0 h-full w-full bg-white z-[114] lg:hidden flex flex-col"
                        >
                            {/* Header - Top Bar */}
                            <div className="flex items-center justify-between px-5 py-3 sm:px-6 sm:py-4">
                                {/* Logo at top left */}
                                <motion.div
                                    initial={{ opacity: 0, scale: 0.8 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    transition={{ duration: 0.3, delay: 0.1 }}
                                    className='flex w-10 h-10 relative'
                                >
                                    <Image src="/logo.png" alt="Otopair Logo" fill className="object-cover" />
                                </motion.div>
                                <div
                                    className='flex flex-row items-center gap-2'>
                                    <motion.button
                                        onClick={() => {
                                            setWaitlistModalOpen(true)
                                            setMobileMenuOpen(false)
                                        }}
                                        className="block relative px-5 py-2 rounded-lg font-medium sm:text-sm text-xs text-white overflow-hidden group"
                                        style={{
                                            background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.8) 0%, rgba(37, 99, 235, 0.9) 100%)',
                                            boxShadow: '0 4px 14px 0 rgba(59, 130, 246, 0.3)',
                                        }}
                                        whileHover={{
                                            scale: 1.05,
                                            boxShadow: '0 6px 20px 0 rgba(59, 130, 246, 0.4)',
                                        }}
                                        whileTap={{ scale: 0.98 }}
                                        transition={{
                                            type: "spring",
                                            stiffness: 400,
                                            damping: 17
                                        }}
                                    >
                                        {/* Shimmer effect */}
                                        <motion.div
                                            className="absolute inset-0"
                                            style={{
                                                background: 'linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.3), transparent)',
                                            }}
                                            animate={{
                                                x: ['-100%', '200%'],
                                            }}
                                            transition={{
                                                duration: 2,
                                                repeat: Infinity,
                                                repeatDelay: 1,
                                                ease: 'linear',
                                            }}
                                        />
                                        {/* Button text */}
                                        <span className="relative z-10 tracking-[-0.15px] inline-flex sm:text-base text-xs items-center gap-2">
                                            Join Waitlist <ChevronRight className='w-4 h-4' />
                                        </span>
                                    </motion.button>
                                    {/* Close Button - Top Right */}
                                    <motion.button
                                        initial={{ opacity: 0, scale: 0.8 }}
                                        animate={{ opacity: 1, scale: 1 }}
                                        transition={{ duration: 0.3, delay: 0.1 }}
                                        onClick={() => setMobileMenuOpen(false)}
                                        className="p-2 rounded-lg transition-all duration-200 hover:bg-gray-100"
                                        aria-label="Close menu"
                                    >
                                        <X className="w-6 h-6 text-gray-700" />
                                    </motion.button>
                                </div>
                            </div>

                            {/* Centered Navigation Items */}
                            <nav className="flex-1 flex flex-col items-center justify-center gap-6 px-6">
                                {navItems.map((item, index) => (
                                    <motion.div
                                        key={item.href}
                                        initial={{ opacity: 0, y: 20 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        transition={{
                                            duration: 0.5,
                                            delay: 0.2 + (index * 0.1),
                                            ease: [0.25, 0.1, 0.25, 1]
                                        }}
                                    >
                                        <Link
                                            href={item.href}
                                            onClick={() => setMobileMenuOpen(false)}
                                            className="text-7xl font-serif text-gray-900 hover:text-gray-700 transition-colors duration-200"
                                            style={{
                                                fontFamily: "var(--font-Jersey_20)",
                                            }}
                                        >
                                            {item.label}
                                        </Link>
                                    </motion.div>
                                ))}
                                <motion.div
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{
                                        duration: 0.5,
                                        delay: 0.5,
                                        ease: [0.25, 0.1, 0.25, 1]
                                    }}
                                >
                                    <Link
                                        href="/dashboard"
                                        onClick={() => setMobileMenuOpen(false)}
                                        className="text-7xl font-serif text-gray-900 hover:text-gray-700 transition-colors duration-200"
                                        style={{
                                            fontFamily: "var(--font-Jersey_20)",
                                        }}
                                    >
                                        Shop Sign-In
                                    </Link>
                                </motion.div>
                            </nav>

                            {/* Bottom Section - Company Info & Logo */}
                            <div className="p-6 flex flex-col items-center gap-6">
                                {/* Logo */}
                                <motion.div
                                    initial={{ opacity: 0, scale: 0.8 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    transition={{
                                        duration: 0.5,
                                        delay: 0.5,
                                        ease: [0.25, 0.1, 0.25, 1]
                                    }}
                                    className='flex w-16 h-16 relative'
                                >
                                    <Image src="/logo.png" alt="Otopair Logo" fill className="object-cover" />
                                </motion.div>

                                {/* Company Info */}
                                <motion.div
                                    initial={{ opacity: 0, y: 10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{
                                        duration: 0.5,
                                        delay: 0.6,
                                        ease: [0.25, 0.1, 0.25, 1]
                                    }}
                                    className="text-center"
                                >
                                    <p className="text-sm text-gray-600 mb-2">Otopair</p>
                                    <p className="text-xs text-gray-500">The future of car repair coordination</p>
                                </motion.div>

                                {/* Social Links */}
                                <motion.div
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    transition={{
                                        duration: 0.5,
                                        delay: 0.7,
                                        ease: [0.25, 0.1, 0.25, 1]
                                    }}
                                    className="flex items-center gap-3"
                                >
                                    <a
                                        href="https://www.linkedin.com/company/repair-connect/"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="w-10 h-10 rounded-lg border border-gray-300 flex items-center justify-center hover:bg-gray-50 transition-colors"
                                        aria-label="LinkedIn"
                                    >
                                        <svg className="w-5 h-5 text-gray-700" fill="currentColor" viewBox="0 0 24 24">
                                            <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
                                        </svg>
                                    </a>
                                    {/* <a
                                        href="https://twitter.com"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="w-10 h-10 rounded-lg border border-gray-300 flex items-center justify-center hover:bg-gray-50 transition-colors"
                                        aria-label="Twitter"
                                    >
                                        <svg className="w-5 h-5 text-gray-700" fill="currentColor" viewBox="0 0 24 24">
                                            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                                        </svg>
                                    </a> */}
                                </motion.div>

                                {/* Copyright */}
                                <motion.p
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    transition={{
                                        duration: 0.5,
                                        delay: 0.8,
                                        ease: [0.25, 0.1, 0.25, 1]
                                    }}
                                    className="text-xs text-gray-400 text-center"
                                >
                                    © Otopair {new Date().getFullYear()}
                                </motion.p>
                            </div>
                        </motion.div>
                    </>
                )}
            </AnimatePresence>

            {/* Waitlist Modal */}
            <AnimatePresence>
                {waitlistModalOpen && (
                    <>
                        {/* Backdrop */}
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[200]"
                            onClick={() => setWaitlistModalOpen(false)}
                        />

                        {/* Modal */}
                        <motion.div
                            initial={{ opacity: 0, scale: 0.95, y: 20 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.95, y: 20 }}
                            transition={{
                                duration: 0.3,
                                ease: [0.25, 0.1, 0.25, 1]
                            }}
                            className="fixed inset-0 z-[201] flex items-center justify-center p-4 pointer-events-none"
                        >
                            <div
                                className="relative w-full max-w-md pointer-events-auto"
                                onClick={(e) => e.stopPropagation()}
                            >
                                {/* Glassmorphism Container */}
                                <div
                                    className="relative rounded-3xl overflow-hidden"
                                    style={{
                                        background: 'linear-gradient(135deg, rgba(255, 255, 255, 0.95) 0%, rgba(255, 255, 255, 0.98) 100%)',
                                        backdropFilter: 'blur(20px)',
                                        border: '1px solid rgba(255, 255, 255, 0.3)',
                                        boxShadow: '0 20px 60px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.1) inset',
                                    }}
                                >
                                    {/* Inner glow */}
                                    <div
                                        className="absolute inset-0 rounded-3xl"
                                        style={{
                                            boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.6), inset 0 -1px 0 rgba(255, 255, 255, 0.4)',
                                        }}
                                    />

                                    {/* Content */}
                                    <div className="relative z-10 p-8">
                                        {/* Close Button */}
                                        <button
                                            onClick={() => setWaitlistModalOpen(false)}
                                            className="absolute top-6 right-6 p-2 rounded-lg hover:bg-gray-100/50 transition-colors"
                                            aria-label="Close"
                                        >
                                            <X className="w-5 h-5 text-gray-600" />
                                        </button>

                                        {/* Logo */}
                                        <div className="flex justify-center mb-6">
                                            <div className="relative w-16 h-16">
                                                <Image src="/logo.png" alt="Otopair Logo" fill className="object-cover" />
                                            </div>
                                        </div>

                                        {/* Title */}
                                        <h2 className="text-3xl font-semibold text-center text-gray-900 mb-2 tracking-tight">
                                            Join the Waitlist
                                        </h2>
                                        <p className="text-center text-gray-600 mb-8 text-sm">
                                            Be among the first to experience the future of car repair coordination
                                        </p>

                                        {/* Success State */}
                                        {submitted ? (
                                            <motion.div
                                                initial={{ opacity: 0, scale: 0.9 }}
                                                animate={{ opacity: 1, scale: 1 }}
                                                className="flex flex-col items-center justify-center py-8"
                                            >
                                                <motion.div
                                                    initial={{ scale: 0 }}
                                                    animate={{ scale: 1 }}
                                                    transition={{ delay: 0.1, type: "spring", stiffness: 200 }}
                                                >
                                                    <CheckCircle2 className="w-16 h-16 text-green-500 mb-4" />
                                                </motion.div>
                                                <p className="text-lg font-semibold text-gray-900 mb-2">You're in!</p>
                                                <p className="text-sm text-gray-600 text-center">
                                                    Check your email for confirmation
                                                </p>
                                            </motion.div>
                                        ) : (
                                            <form onSubmit={handleWaitlistSubmit} className="space-y-4">
                                                {/* Name Input (Optional) */}
                                                <div className="relative">
                                                    <input
                                                        type="text"
                                                        placeholder="Name (optional)"
                                                        value={name}
                                                        onChange={(e) => setName(e.target.value)}
                                                        className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-white/80 backdrop-blur-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50 transition-all"
                                                        style={{ fontSize: "16px" }}
                                                    />
                                                </div>

                                                {/* Email Input */}
                                                <div className="relative">
                                                    <input
                                                        type="email"
                                                        placeholder="Enter your email"
                                                        value={email}
                                                        onChange={(e) => setEmail(e.target.value)}
                                                        required
                                                        className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-white/80 backdrop-blur-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50 transition-all"
                                                        style={{ fontSize: "16px" }}
                                                    />
                                                </div>

                                                {/* Submit Button */}
                                                <motion.button
                                                    type="submit"
                                                    disabled={!email || submitted}
                                                    className="w-full relative px-6 py-3 rounded-xl font-semibold text-white overflow-hidden group disabled:opacity-50 disabled:cursor-not-allowed"
                                                    style={{
                                                        background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.9) 0%, rgba(37, 99, 235, 1) 100%)',
                                                        boxShadow: '0 4px 14px 0 rgba(59, 130, 246, 0.4)',
                                                    }}
                                                    whileHover={!submitted && email ? {
                                                        scale: 1.02,
                                                        boxShadow: '0 6px 20px 0 rgba(59, 130, 246, 0.5)',
                                                    } : {}}
                                                    whileTap={!submitted && email ? { scale: 0.98 } : {}}
                                                    transition={{
                                                        type: "spring",
                                                        stiffness: 400,
                                                        damping: 17
                                                    }}
                                                >
                                                    {/* Shimmer effect */}
                                                    <motion.div
                                                        className="absolute inset-0"
                                                        style={{
                                                            background: 'linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.3), transparent)',
                                                        }}
                                                        animate={{
                                                            x: ['-100%', '200%'],
                                                        }}
                                                        transition={{
                                                            duration: 2,
                                                            repeat: Infinity,
                                                            repeatDelay: 1,
                                                            ease: 'linear',
                                                        }}
                                                    />
                                                    <span className="relative z-10 inline-flex items-center justify-center gap-2">
                                                        Join Waitlist <ChevronRight className='w-4 h-4' />
                                                    </span>
                                                </motion.button>

                                                <p className="text-xs text-center text-gray-500 mt-4">
                                                    We'll never spam you. Unsubscribe at any time.
                                                </p>
                                            </form>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </motion.div>
                    </>
                )}
            </AnimatePresence>
        </>
    )
}

export default Navbar

// Liquid Glass
// <div className="relative w-full p-4 rounded-3xl overflow-hidden">
// {/* SVG Filter Definition */}
// <svg style={{ display: 'none' }}>
//     <filter id="displacementFilter">
//         <feTurbulence
//             type="turbulence"
//             baseFrequency="0.01"
//             numOctaves="2"
//             result="turbulence"
//         />
//         <feDisplacementMap
//             in="SourceGraphic"
//             in2="turbulence"
//             scale="200"
//             xChannelSelector="R"
//             yChannelSelector="G"
//         />
//     </filter>
// </svg>

// {/* Liquid Glass Background */}
// <div
//     className="absolute inset-0 w-full h-full rounded-3xl overflow-hidden"
//     style={{
//         filter: 'drop-shadow(-8px -10px 46px #0000005f)',
//         backdropFilter: 'brightness(1.1) blur(2px)',
//         border: '1px solid rgba(255, 255, 255, 0.2)',
//     }}
// >
//     <div
//         className="absolute inset-0 rounded-3xl"
//         style={{
//             boxShadow: 'inset 6px 6px 0px -6px rgba(255, 255, 255, 0.7), inset 0 0 8px 1px rgba(255, 255, 255, 0.7)',
//         }}
//     />
// </div>