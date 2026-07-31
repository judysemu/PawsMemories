import React from "react";
import { Award, Flame, CheckCircle, Lock, Trophy, Sparkles } from "lucide-react";

export interface Achievement {
  id: string;
  title: string;
  desc: string;
  reward: number;
  icon: string;
  isUnlocked: boolean;
  isClaimed: boolean;
}

interface AchievementsPanelProps {
  streak: number;
  achievements: Achievement[];
  onClaimReward: (id: string) => void;
  onClaimDailyStreak: () => void;
  dailyStreakClaimed: boolean;
}

export default function AchievementsPanel({
  streak,
  achievements,
  onClaimReward,
  onClaimDailyStreak,
  dailyStreakClaimed,
}: AchievementsPanelProps) {
  const completedCount = achievements.filter(a => a.isUnlocked).length;
  const totalCount = achievements.length;
  const progressPercent = Math.round((completedCount / totalCount) * 100);

  return (
    <section className="glass-panel rounded-3xl p-6 border border-outline-variant/30 shadow-sm space-y-6">
      
      {/* Header and Streak Info */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-outline-variant/20 pb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-amber-500/15 text-amber-500 flex items-center justify-center">
            <Trophy size={20} className="animate-pulse" />
          </div>
          <div>
            <h3 className="text-sm font-black text-on-surface uppercase tracking-wider font-sans">
              Achievements &amp; Streaks
            </h3>
            <p className="text-xs text-on-surface-variant font-medium">
              Complete milestones that Pawsome3D can verify from your account.
            </p>
          </div>
        </div>

        {/* Real Streak Indicator */}
        <div className="flex items-center gap-3 bg-gradient-to-r from-orange-500/10 to-amber-500/5 py-1.5 px-4 rounded-2xl border border-orange-500/20 shadow-sm shrink-0">
          <Flame size={16} className="text-orange-500 animate-bounce" />
          <div className="text-left leading-none">
            <span className="text-[10px] font-bold text-on-surface-variant uppercase tracking-wider block">Daily Streak</span>
            <span className="text-xs font-black text-orange-600 font-mono">{streak} Days Active</span>
          </div>
          <button
            onClick={onClaimDailyStreak}
            disabled={dailyStreakClaimed}
            className={`ml-2 px-2.5 py-1 rounded-lg text-[10px] font-black uppercase transition-all cursor-pointer ${
              dailyStreakClaimed
                ? "bg-outline-variant/30 text-on-surface-variant/40"
                : "bg-orange-500 text-white hover:bg-orange-600 shadow-sm"
            }`}
          >
            {dailyStreakClaimed ? "Claimed" : "Claim reward"}
          </button>
        </div>
      </div>

      {/* Progress Bar */}
      <div className="space-y-2">
        <div className="flex justify-between text-xs font-bold text-on-surface">
          <span>Overall Unlocked Benchmark</span>
          <span className="text-primary font-mono">{completedCount} / {totalCount} ({progressPercent}%)</span>
        </div>
        <div className="w-full h-2.5 bg-outline-variant/30 rounded-full overflow-hidden">
          <div 
            className="h-full bg-gradient-to-r from-primary to-primary-container transition-all duration-500 rounded-full"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>

      {/* Achievements List */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {achievements.map((achievement) => (
          <div
            key={achievement.id}
            className={`p-4 rounded-2xl border transition-all flex items-start gap-3.5 relative overflow-hidden ${
              achievement.isClaimed
                ? "bg-surface-container-low/55 border-outline-variant/15 opacity-65"
                : achievement.isUnlocked
                ? "bg-white border-primary/25 shadow-sm hover:shadow-md dark:bg-slate-900 border-primary/40"
                : "bg-surface-container-low/40 border-outline-variant/20"
            }`}
          >
            {/* Visual background sparkles if unlocked & unclaimed */}
            {achievement.isUnlocked && !achievement.isClaimed && (
              <div className="absolute top-0 right-0 w-8 h-8 bg-primary/10 rounded-bl-full flex items-center justify-center text-[10px]">
                <Sparkles size={10} className="text-primary animate-spin animate-duration-[4000ms]" />
              </div>
            )}

            {/* Achievement Icon */}
            <div className="text-2xl pt-0.5 select-none">{achievement.icon}</div>

            {/* Content text */}
            <div className="flex-grow space-y-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <h4 className="text-xs font-black text-on-surface leading-snug">
                  {achievement.title}
                </h4>
                {achievement.isClaimed ? (
                  <span className="text-[9px] bg-outline-variant/20 text-on-surface-variant font-bold px-1.5 py-0.5 rounded-full uppercase scale-[0.9]">
                    Claimed
                  </span>
                ) : achievement.isUnlocked ? (
                  <span className="text-[9px] bg-emerald-500/10 text-emerald-600 font-bold px-1.5 py-0.5 rounded-full uppercase scale-[0.9] flex items-center gap-0.5">
                    <CheckCircle size={8} /> Ready
                  </span>
                ) : (
                  <span className="text-[9px] bg-outline-variant/10 text-on-surface-variant/50 font-bold px-1.5 py-0.5 rounded-full uppercase scale-[0.9] flex items-center gap-0.5">
                    <Lock size={8} /> Locked
                  </span>
                )}
              </div>
              <p className="text-[11px] text-on-surface-variant font-medium leading-normal">
                {achievement.desc}
              </p>

              {/* Claim Reward Button */}
              {achievement.isUnlocked && !achievement.isClaimed && (
                <button
                  onClick={() => onClaimReward(achievement.id)}
                  className="mt-2 py-1 px-3 bg-primary text-white text-[10px] font-black uppercase rounded-lg hover:bg-primary/95 shadow-sm active:scale-95 duration-100 transition-all cursor-pointer flex items-center gap-1 w-fit"
                >
                  Claim +{achievement.reward}cr Bonus
                </button>
              )}

              {/* Display reward details if already claimed or locked */}
              {(achievement.isClaimed || !achievement.isUnlocked) && (
                <span className="text-[10px] text-on-surface-variant font-bold block mt-1">
                  Reward: <span className="text-secondary font-mono">+{achievement.reward}cr</span>
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

    </section>
  );
}
