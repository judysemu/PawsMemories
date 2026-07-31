import React from "react";
import { Sparkles, ArrowRight } from "lucide-react";
import { Album, Creation, UserProfile } from "../types";
import { Achievement } from "./AchievementsPanel";

interface DashboardProps {
  userProfile: UserProfile;
  albums: Album[];
  creations: Creation[];
  onAddMemory: () => void;
  onCreate: () => void;
  onClaimDailyBonus: () => void;
  onSelectCreation: (creation: Creation) => void;
  streak: number;
  achievements: Achievement[];
  onClaimReward: (id: string) => void;
  onClaimDailyStreak: () => void;
  dailyStreakClaimed: boolean;
  onSelectAlbum: (album: Album) => void;
  onCreateAlbum: (name: string) => Promise<void>;
  onOpenAdminPanel?: () => void;
  /** Navigate to the Furball3D avatar builder. */
  onOpenFurball?: () => void;
  /** Navigate to Pawprints. */
  onOpenPawprints?: () => void;
  /** Navigate to Fido's Styles. */
  onOpenFidos?: () => void;
}

export default function Dashboard({ userProfile, streak, dailyStreakClaimed, onClaimDailyStreak, onCreate, onOpenFurball, onOpenPawprints, onOpenFidos }: DashboardProps) {
  const petName = userProfile.fullName.split(" ")[0] + "'s Pet"; // Defaulting to something nice

  return (
    <div className="w-full h-full min-h-[calc(100dvh-64px)] flex flex-col items-center justify-between pt-12 pb-24 md:pb-12 px-6 relative overflow-hidden">
      
      {/* Top Section: Daily Streak & Welcome */}
      <div className="w-full max-w-5xl flex justify-between items-start z-10 pt-4 md:pt-0">
        <div>
          <h1 className="text-2xl md:text-4xl font-extrabold text-on-surface drop-shadow-md">
            Welcome back, <br className="md:hidden" /><span className="text-primary">{userProfile.fullName.split(" ")[0]}!</span>
          </h1>
          <p className="text-on-surface-variant text-sm md:text-base mt-1.5 font-medium">Ready for another adventure?</p>
        </div>
        
        {/* Streak Badge */}
        <button 
          onClick={() => !dailyStreakClaimed && onClaimDailyStreak()}
          className={`flex flex-col items-center justify-center p-3 rounded-2xl backdrop-blur-xl border transition-all ${dailyStreakClaimed ? 'bg-primary/20 border-primary/30' : 'bg-surface/50 border-white/20 hover:scale-105 cursor-pointer shadow-lg'}`}
        >
          <div className="flex items-center gap-1.5">
            <Sparkles className={dailyStreakClaimed ? "text-primary" : "text-amber-400"} size={18} />
            <span className="font-bold text-xl leading-none">{streak}</span>
          </div>
          <span className="text-[10px] font-extrabold uppercase tracking-wider mt-1 opacity-80">Day Streak</span>
        </button>
      </div>

      {/* Home destinations: wide, low-opacity glass tiles keep the page quiet while
          using the same product artwork as the global shell. */}
      <div className="flex-1 w-full flex flex-col items-center justify-center relative z-10 my-8">
        <div className="absolute h-64 w-64 rounded-full bg-primary/20 blur-[90px]" />
        <div className="relative grid w-full max-w-5xl grid-cols-1 gap-4 md:grid-cols-2">
          {[
            { label: "Furball3D", title: "Make your pet", detail: "Turn a photo or idea into a keepsake.", image: "/brand/furball3d.jpg", action: () => (onOpenFurball ? onOpenFurball() : onCreate()), tour: "dashboard-create" },
            { label: "Fido's Styles", title: "Create the look", detail: "Build wardrobe looks and style variations.", image: "/brand/fidostyles.jpg", action: () => onOpenFidos?.() },
            { label: "Pawprints", title: "Make a keepsake", detail: "Add photos and words for any occasion.", image: "/brand/pawprints.png", action: () => onOpenPawprints?.() },
          ].map((item) => (
            <button key={item.label} data-tour={item.tour} type="button" onClick={item.action} className="glass-tile group flex min-h-36 items-center gap-5 rounded-[1.75rem] p-5 text-left md:min-h-44 md:p-6">
              <img src={item.image} alt="" className="h-24 w-24 shrink-0 rounded-2xl object-cover shadow-md ring-1 ring-white/50 md:h-28 md:w-28" />
              <span className="min-w-0"><span className="text-[10px] font-black uppercase tracking-[.18em] text-primary">{item.label}</span><strong className="mt-1 block text-2xl font-black tracking-tight text-on-surface">{item.title}</strong><span className="mt-2 block max-w-xs text-sm leading-5 text-on-surface-variant">{item.detail}</span><span className="mt-3 inline-flex items-center gap-2 text-xs font-black text-primary">Open <ArrowRight size={14} className="transition group-hover:translate-x-1" /></span></span>
            </button>
          ))}
        </div>
      </div>
      
    </div>
  );
}
