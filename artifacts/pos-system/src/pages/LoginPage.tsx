import { useState, useEffect, useRef } from "react";
import { useStaff } from "@/lib/staff-context";
import { seedDefaultStaff, seedDefaultAggregatorSettings } from "@/lib/firestore";

export default function LoginPage() {
  const { login, allStaff } = useStaff();
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [seeding, setSeeding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (allStaff.length === 0 && !seeding) {
      setSeeding(true);
      Promise.all([
        seedDefaultStaff().catch(() => {}),
        seedDefaultAggregatorSettings().catch(() => {}),
      ]).finally(() => setSeeding(false));
    }
  }, [allStaff.length, seeding]);

  const handlePinInput = (digit: string) => {
    if (pin.length >= 4) return;
    const newPin = pin + digit;
    setPin(newPin);
    setError("");
    if (newPin.length === 4) {
      const success = login(newPin);
      if (!success) {
        setError("Invalid PIN");
        setTimeout(() => { setPin(""); setError(""); }, 1000);
      }
    }
  };

  const handleBackspace = () => {
    setPin((p) => p.slice(0, -1));
    setError("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key >= "0" && e.key <= "9") {
      handlePinInput(e.key);
    } else if (e.key === "Backspace") {
      handleBackspace();
    }
  };

  const digits = ["1","2","3","4","5","6","7","8","9","","0","←"];

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center"
      style={{ background: "#030305" }}
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      <div className="text-center mb-10">
        <h1
          className="text-4xl font-bold tracking-wider mb-2"
          style={{ color: "#C9A84C", fontFamily: "Playfair Display, serif" }}
        >
          H.O.D
        </h1>
        <p className="text-sm tracking-widest" style={{ color: "hsl(36 29% 70%)" }}>
          HOUSE OF DOPAMINE
        </p>
        <p className="text-xs mt-1" style={{ color: "hsl(36 29% 50%)" }}>
          Point of Sale System
        </p>
      </div>

      <div className="mb-6">
        <p className="text-center text-sm mb-4" style={{ color: "hsl(36 29% 70%)" }}>
          Enter your 4-digit PIN
        </p>
        <div className="flex gap-3 justify-center">
          {[0,1,2,3].map((i) => (
            <div
              key={i}
              className="w-12 h-12 rounded-lg flex items-center justify-center text-xl font-bold transition-all"
              style={{
                background: pin.length > i ? "#C9A84C" : "hsl(240 12% 8%)",
                border: `2px solid ${pin.length > i ? "#C9A84C" : error ? "#ef4444" : "hsl(240 8% 18%)"}`,
                color: pin.length > i ? "#030305" : "transparent",
              }}
            >
              {pin.length > i ? "●" : ""}
            </div>
          ))}
        </div>
        {error && (
          <p className="text-center text-sm mt-3" style={{ color: "#ef4444" }}>
            {error}
          </p>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3 max-w-xs">
        {digits.map((d, i) => {
          if (d === "") return <div key={i} />;
          if (d === "←") {
            return (
              <button
                key={i}
                onClick={handleBackspace}
                className="w-16 h-16 rounded-xl flex items-center justify-center text-xl transition-all active:scale-95"
                style={{
                  background: "hsl(240 12% 8%)",
                  border: "1px solid hsl(240 8% 18%)",
                  color: "hsl(36 29% 80%)",
                }}
              >
                ⌫
              </button>
            );
          }
          return (
            <button
              key={i}
              onClick={() => handlePinInput(d)}
              className="w-16 h-16 rounded-xl flex items-center justify-center text-2xl font-semibold transition-all active:scale-95 hover:brightness-125"
              style={{
                background: "hsl(240 12% 8%)",
                border: "1px solid hsl(240 8% 18%)",
                color: "hsl(36 29% 93%)",
              }}
            >
              {d}
            </button>
          );
        })}
      </div>

      <input
        ref={inputRef}
        type="text"
        className="opacity-0 absolute"
        autoFocus
        onKeyDown={handleKeyDown}
      />

      {seeding && (
        <p className="text-xs mt-8" style={{ color: "hsl(36 29% 40%)" }}>
          Setting up initial data...
        </p>
      )}

      <div className="mt-12 flex gap-4">
        {[
          { href: "/captain", label: "Captain Mode", icon: "🪩" },
          { href: "/bar", label: "Bar Mode", icon: "🍸" },
          { href: "/door", label: "Door Mode", icon: "🚪" },
        ].map((m) => (
          <a
            key={m.href}
            href={`${import.meta.env.BASE_URL.replace(/\/$/, "")}${m.href}`}
            className="flex flex-col items-center gap-1 px-4 py-3 rounded-xl transition-all hover:brightness-125"
            style={{
              background: "hsl(240 12% 6%)",
              border: "1px solid hsl(240 8% 15%)",
              textDecoration: "none",
            }}
          >
            <span className="text-lg">{m.icon}</span>
            <span className="text-[10px] font-medium" style={{ color: "hsl(36 29% 55%)" }}>{m.label}</span>
          </a>
        ))}
      </div>
    </div>
  );
}
