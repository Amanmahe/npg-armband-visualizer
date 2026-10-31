"use client";
import { useTheme } from "next-themes";
import { Moon, Sun, Activity } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function Navbar({ isDisplay }: { isDisplay: boolean }) {
  const { theme, setTheme } = useTheme();

  return (
    <nav className="flex items-center justify-between px-5 py-3">
      <div className="flex items-center gap-2">
        <Activity className="text-primary" size={22} />
        <span className="font-semibold tracking-tight">NPG-Lite Band</span>
      </div>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        aria-label="Toggle theme"
      >
        {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
      </Button>
    </nav>
  );
}
