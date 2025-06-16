"use client"

import Link from "next/link"
import { FC } from "react"
import { ChatbotUISVG } from "../icons/chatbotui-svg"
import { PepperAISVG } from "../icons/pepperai-svg"

interface BrandProps {
  theme?: "dark" | "light"
}

export const Brand: FC<BrandProps> = ({ theme = "dark" }) => {
  return (
    <Link
      className="flex cursor-pointer flex-col items-center hover:opacity-50"
      href="https://www.chatbotui.com"
      target="_blank"
      rel="noopener noreferrer"
    >
      <div className="mb-2">
        <img
          src="/Pepper Infinity Logo.png"
          alt="Pepper AI Logo"
          style={{ width: 120, height: 120, objectFit: "contain" }}
        />
      </div>

      <div className="text-4xl font-bold tracking-wide">Pepper AI</div>
    </Link>
  )
}
