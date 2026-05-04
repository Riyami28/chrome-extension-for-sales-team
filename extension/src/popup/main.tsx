import React, { useState } from "react";
import { createRoot } from "react-dom/client";

function Popup() {
  const [hover, setHover] = useState(false);

  function openSidebar() {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab?.id) chrome.sidePanel.open({ tabId: tab.id });
      window.close();
    });
  }

  return (
    <div
      style={{
        padding: "14px",
        background: "#060608",
        color: "#F0EBDB",
        fontFamily: "'Space Grotesk', system-ui, -apple-system, sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          marginBottom: "14px",
        }}
      >
        <div
          style={{
            width: 32,
            height: 32,
            background: "#F58549",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
              fontWeight: 800,
              fontSize: 13,
              color: "#0A0A0A",
              letterSpacing: "-0.02em",
            }}
          >
            CL
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1 }}>
          <span
            style={{
              fontWeight: 600,
              fontSize: 14,
              color: "#F0EBDB",
              letterSpacing: "-0.02em",
            }}
          >
            ClientLens
          </span>
          <span
            style={{
              fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
              fontSize: 9,
              textTransform: "uppercase",
              letterSpacing: "0.14em",
              color: "#8A8378",
              marginTop: 3,
            }}
          >
            Sales Copilot
          </span>
        </div>
      </div>
      <button
        onClick={openSidebar}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          width: "100%",
          padding: "9px 12px",
          background: "#F58549",
          color: "#0A0A0A",
          border: "none",
          borderRadius: 0,
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 600,
          fontFamily: "'Space Grotesk', system-ui, sans-serif",
          letterSpacing: "-0.01em",
          transition: "box-shadow 140ms ease, transform 140ms ease",
          boxShadow: hover ? "0 8px 0 -4px #F58549" : "none",
          transform: hover ? "translateY(-1px)" : "translateY(0)",
        }}
      >
        Open Sales Copilot →
      </button>
      <div
        style={{
          marginTop: 10,
          fontSize: 10,
          color: "#5A5A62",
          textAlign: "center",
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          textTransform: "uppercase",
          letterSpacing: "0.14em",
        }}
      >
        Opens in side panel
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Popup />);
