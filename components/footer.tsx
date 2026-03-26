'use client'
import React, { useState } from 'react'
import { ArrowRight, Linkedin, Twitter, Wrench, ChevronRight } from 'lucide-react'
import Link from 'next/link'
import FooterTransBar from './footer-trans-bar'
import { ChevronMarqueeButton } from './ui/chevron-marquee-button'
const navLinks = [
    { label: 'Home', href: '/' },
    { label: 'About', href: '/about' },
    { label: 'Writing', href: '/writing' },
    { label: 'Careers', href: '/careers' },
    { label: 'Privacy Policy', href: '/privacy' },
    { label: 'Company', href: '/company' },
]
export default function Footer() {
    const [email, setEmail] = useState('')

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault()
        // Handle email subscription
        console.log('Email submitted:', email)
        setEmail('')
    }
    return (
        <footer className="w-full border-t border-neutral-200 bg-white">
            {/* Header Section */}
            <div className="flex flex-col items-center justify-center px-6 lg:px-8 py-20 ">
                <div className="flex items-center flex-col gap-3 mb-4">
                    <Wrench className="w-6 h-6 text-black" />
                    <h2 className="text-2xl sm:text-3xl lg:text-4xl text-black text-center"
                        style={{ fontFamily: "var(--font-Jersey_20)" }}
                    >
                        We're building bookings that<br /> don't need phone-tag
                    </h2>
                </div>
                <div className="text-sm sm:text-base text-neutral-600 mb-8 text-center flex sm:flex-row flex-col items-center justify-center gap-2 sm:mt-0 mt-8">
                    If that sounds interesting to you, <span className='text-black underline flex items-center gap-2'>come work with us <ChevronMarqueeButton className='' /></span>{' '}
                </div>
            </div>

            {/* Navigation & Subscription Section */}
            <div className="mx-auto max-w-7xl px-6 lg:px-8 py-12">
                <div className="flex flex-col sm:flex-row items-center justify-between gap-6">
                    {/* Left Section - Navigation Links */}
                    <div className="flex flex-wrap items-center justify-center sm:justify-start gap-4 sm:gap-6">
                        {navLinks.map((link) => (
                            <Link
                                key={link.href}
                                href={link.href}
                                className="sm:text-sm text-xs text-neutral-900 hover:text-neutral-600 transition-colors"
                            >
                                {link.label}
                            </Link>
                        ))}
                    </div>

                    {/* Right Section - Email Subscription & Social Icons */}
                    <div className="flex items-center gap-4">
                        {/* Email Subscription */}
                        <form onSubmit={handleSubmit} className="flex items-center">
                            <div className="relative flex items-center bg-neutral-100 rounded-lg overflow-hidden group hover:bg-neutral-200 transition-colors">
                                <input
                                    type="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    placeholder="Get updates in your inbox"
                                    className="px-4 py-2 bg-transparent text-sm text-neutral-700 placeholder-neutral-500 outline-none w-[200px] sm:w-[240px]"
                                />
                                <button
                                    type="submit"
                                    className="px-3 py-2 flex items-center justify-center"
                                    aria-label="Subscribe"
                                >
                                    <ArrowRight className="w-4 h-4 text-neutral-700" />
                                </button>
                            </div>
                        </form>

                        {/* Social Media Icons */}
                        <div className="flex items-center gap-2">
                            {/* <a
                                href="https://twitter.com"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="w-8 h-8 bg-neutral-900 rounded-lg flex items-center justify-center hover:bg-neutral-800 transition-colors"
                                aria-label="Twitter"
                            >
                                <Twitter className="w-4 h-4 text-white" />
                            </a> */}
                            <a
                                href="https://www.linkedin.com/company/repair-connect/"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="w-8 h-8 bg-neutral-900 rounded-lg flex items-center justify-center hover:bg-neutral-800 transition-colors"
                                aria-label="LinkedIn"
                            >
                                <Linkedin className="w-4 h-4 text-white" />
                            </a>
                        </div>
                    </div>
                </div>
            </div>
            <FooterTransBar />
        </footer>
    )
}