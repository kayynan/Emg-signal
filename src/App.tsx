/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import { 
  Activity, 
  Settings, 
  Play, 
  Square, 
  Zap, 
  Info, 
  Cpu, 
  Download,
  Terminal,
  RefreshCw,
  ExternalLink,
  ChevronRight,
  AlertCircle,
  Database,
  Layers,
  X,
  Copy
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "./lib/utils";

// --- Types ---
interface SerialPort {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

interface EMGDataPoint {
  time: number;
  raw: number;
  rectified: number;
  rms: number;
  active: boolean;
}

// --- Constants ---
const BUFFER_SIZE = 200; // Number of points to show in the history chart
const RMS_WINDOW_SIZE = 50; // Window size for RMS calculation
const SAMPLING_RATE_ESTIMATE = 500; // Hz (approximate)

// --- Components ---
const Knob = ({ 
  value, 
  min, 
  max, 
  onChange, 
  label, 
  unit = "", 
  step = 1 
}: { 
  value: number, 
  min: number, 
  max: number, 
  onChange: (val: number) => void, 
  label: string, 
  unit?: string,
  step?: number
}) => {
  const knobRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const startYRef = useRef(0);
  const startValueRef = useRef(0);

  // Calculate rotation angle (-135 to 135 degrees)
  const percentage = (value - min) / (max - min);
  const angle = -135 + (percentage * 270);

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    setIsDragging(true);
    startYRef.current = e.clientY;
    startValueRef.current = value;
    
    // Capture pointer events to track outside the element
    if (knobRef.current) {
      knobRef.current.setPointerCapture(e.pointerId);
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging) return;
    
    const deltaY = startYRef.current - e.clientY;
    // Sensitivity: 100 pixels = full range
    const deltaValue = (deltaY / 100) * (max - min);
    
    let newValue = startValueRef.current + deltaValue;
    
    // Apply step if needed
    if (step !== 1) {
      newValue = Math.round(newValue / step) * step;
    }
    
    newValue = Math.max(min, Math.min(max, newValue));
    onChange(newValue);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    setIsDragging(false);
    if (knobRef.current) {
      knobRef.current.releasePointerCapture(e.pointerId);
    }
  };

  return (
    <div className="flex flex-col items-center gap-3">
      <div 
        ref={knobRef}
        className="w-16 h-16 rounded-full bg-[#f0f0f0] border border-[#ccc] shadow-[inset_0_2px_10px_rgba(0,0,0,0.1),0_0_15px_rgba(0,0,0,0.05)] relative cursor-ns-resize flex items-center justify-center group"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {/* Indicator Line */}
        <div 
          className="absolute w-full h-full rounded-full transition-transform duration-75"
          style={{ transform: `rotate(${angle}deg)` }}
        >
          <div className="absolute top-1.5 left-1/2 -translate-x-1/2 w-1 h-3 bg-blue-500 rounded-full shadow-[0_0_5px_rgba(59,130,246,0.5)]" />
        </div>
        {/* Inner circle for depth */}
        <div className="w-10 h-10 rounded-full bg-[#e4e9ec] shadow-[inset_0_2px_5px_rgba(0,0,0,0.1)] border border-[#ccc]" />
      </div>
      <div className="text-center">
        <div className="text-[10px] font-bold tracking-widest text-gray-600 uppercase mb-1">{label}</div>
        <div className="text-xs text-black font-mono">{value.toFixed(step < 1 ? 1 : 0)}{unit}</div>
      </div>
    </div>
  );
};

export default function App() {
  // --- State ---
  const [isConnected, setIsConnected] = useState(false);
  const [port, setPort] = useState<SerialPort | null>(null);
  const [threshold, setThreshold] = useState(50);
  const [baseline, setBaseline] = useState(512); // Default for 10-bit ADC
  const [gain, setGain] = useState(2);
  const [rmsWindowSize, setRmsWindowSize] = useState(50);
  const [invert, setInvert] = useState(false);
  const [filterEnabled, setFilterEnabled] = useState(true);
  const [notchFilter, setNotchFilter] = useState<'none' | '50Hz' | '60Hz'>('50Hz');
  const [history, setHistory] = useState<EMGDataPoint[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [showArduinoCode, setShowArduinoCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [baudRate, setBaudRate] = useState(115200);
  const [lastRawString, setLastRawString] = useState<string>("None");
  const [lastLines, setLastLines] = useState<string[]>([]);
  const [bytesReceived, setBytesReceived] = useState(0);
  const [lastDataTimestamp, setLastDataTimestamp] = useState<number | null>(null);
  const [dataRate, setDataRate] = useState(0);
  const [isSimulating, setIsSimulating] = useState(false);
  const [showTroubleshooting, setShowTroubleshooting] = useState(false);
  const [lastDataTime, setLastDataTime] = useState(0);
  const [peakRms, setPeakRms] = useState(0);
  const [useFixedScale, setUseFixedScale] = useState(true);
  const [chartMode, setChartMode] = useState<'rms' | 'rectified'>('rms');
  const [timeWindow, setTimeWindow] = useState(1000);
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [isPwaInstalled, setIsPwaInstalled] = useState(false);
  
  // --- Refs for High-Frequency Data & Config ---
  const baselineRef = useRef(baseline);
  const thresholdRef = useRef(threshold);
  const invertRef = useRef(invert);
  const gainRef = useRef(gain);
  const filterEnabledRef = useRef(filterEnabled);
  const notchFilterRef = useRef(notchFilter);
  const rmsWindowSizeRef = useRef(rmsWindowSize);
  const timeWindowRef = useRef(timeWindow);

  // --- PWA Installation Logic ---
  useEffect(() => {
    const handleBeforeInstallPrompt = (e: any) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };

    const handleAppInstalled = () => {
      setIsPwaInstalled(true);
      setDeferredPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    if (window.matchMedia('(display-mode: standalone)').matches) {
      setIsPwaInstalled(true);
    }

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const handleInstallClick = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setDeferredPrompt(null);
    }
  };

  // Filter state variables (IIR)
  const lastRawRef = useRef(0);
  const lastFilteredRef = useRef(0);
  const notchZ1Ref = useRef(0);
  const notchZ2Ref = useRef(0);
  const sumSqRef = useRef(0);
  const rmsWindowRef = useRef<number[]>([]);

  const rawDataRef = useRef<number[]>([]);
  const rawInputRef = useRef<number[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rmsCanvasRef = useRef<HTMLCanvasElement>(null);
  const readerRef = useRef<ReadableStreamDefaultReader | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const rmsAnimationFrameRef = useRef<number | null>(null);
  const simulationIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastProcessedTimeRef = useRef<number>(Date.now());
  const sampleCountRef = useRef(0);
  const peakRmsRef = useRef(0);

  // Sync refs with state
  useEffect(() => { baselineRef.current = baseline; }, [baseline]);
  useEffect(() => { thresholdRef.current = threshold; }, [threshold]);
  useEffect(() => { invertRef.current = invert; }, [invert]);
  useEffect(() => { gainRef.current = gain; }, [gain]);
  useEffect(() => { filterEnabledRef.current = filterEnabled; }, [filterEnabled]);
  useEffect(() => { notchFilterRef.current = notchFilter; }, [notchFilter]);
  useEffect(() => { rmsWindowSizeRef.current = rmsWindowSize; }, [rmsWindowSize]);
  useEffect(() => { timeWindowRef.current = timeWindow; }, [timeWindow]);

  // --- Signal Processing ---
  const processNewValue = useCallback((value: number) => {
    const now = Date.now();
    let centered = value - baselineRef.current;
    if (invertRef.current) centered = -centered;

    let filtered = centered;

    if (filterEnabledRef.current) {
      // 1. High-Pass Filter (approx 20Hz at 500Hz sampling)
      const alphaHP = 0.9;
      filtered = alphaHP * (lastFilteredRef.current + centered - lastRawRef.current);
      
      // Safety check for filter stability
      if (!isFinite(filtered) || Math.abs(filtered) > 1024) filtered = centered;
      
      lastRawRef.current = centered;
      lastFilteredRef.current = filtered;

      // 2. Notch Filter (50Hz or 60Hz)
      if (notchFilterRef.current !== 'none') {
        const freq = notchFilterRef.current === '50Hz' ? 50 : 60;
        const fs = 500; 
        const r = 0.95; 
        const omega = (2 * Math.PI * freq) / fs;
        const cosW = Math.cos(omega);
        
        const inVal = filtered;
        const outVal = inVal - 2 * cosW * notchZ1Ref.current + notchZ2Ref.current;
        const finalOut = outVal - 2 * cosW * r * notchZ1Ref.current + r * r * notchZ2Ref.current;
        
        // Safety check
        if (isFinite(finalOut) && Math.abs(finalOut) < 2048) {
          notchZ2Ref.current = notchZ1Ref.current;
          notchZ1Ref.current = outVal;
          filtered = finalOut;
        } else {
          // Reset notch state on instability
          notchZ1Ref.current = 0;
          notchZ2Ref.current = 0;
        }
      }

      // 3. Low-Pass Filter (approx 150Hz at 500Hz sampling)
      const alphaLP = 0.6;
      filtered = alphaLP * filtered + (1 - alphaLP) * lastFilteredRef.current;
    }

    // Final safety clamp
    if (!isFinite(filtered)) filtered = centered;
    
    // Add to raw buffer for canvas
    rawDataRef.current.push(filtered);
    if (rawDataRef.current.length > 2000) rawDataRef.current.shift();
    
    // Add to raw input buffer for calibration
    rawInputRef.current.push(value);
    if (rawInputRef.current.length > 1000) rawInputRef.current.shift();

    // Optimize RMS calculation with running sum of squares
    const sq = filtered * filtered;
    sumSqRef.current += sq;
    rmsWindowRef.current.push(sq);
    
    if (rmsWindowRef.current.length > rmsWindowSizeRef.current) {
      const removed = rmsWindowRef.current.shift() || 0;
      sumSqRef.current -= removed;
    }
    
    // Ensure sumSq doesn't drift due to precision
    if (sumSqRef.current < 0) sumSqRef.current = 0;

    const rms = Math.sqrt(sumSqRef.current / Math.max(1, rmsWindowRef.current.length));
    const active = rms > thresholdRef.current;

    // Update peak RMS state (throttled)
    if (rms > peakRmsRef.current) {
      peakRmsRef.current = rms;
    }

    sampleCountRef.current++;

    // Update history for Recharts (throttled for performance)
    if (now - lastProcessedTimeRef.current > 33) { // ~30Hz update for history to reduce React render lag
      const elapsed = (now - lastProcessedTimeRef.current) / 1000;
      setDataRate(Math.round(sampleCountRef.current / elapsed));
      sampleCountRef.current = 0;
      
      setLastDataTime(now);
      setPeakRms(peakRmsRef.current);
      const rectified = Math.abs(filtered);
      setHistory(prev => {
        const newPoint = {
          time: now,
          raw: centered,
          rectified,
          rms: peakRmsRef.current, // Use peak RMS in the window for better visualization
          active
        };
        const newHistory = [...prev, newPoint];
        return newHistory.slice(-BUFFER_SIZE);
      });
      peakRmsRef.current = 0; // Reset peak after logging
      lastProcessedTimeRef.current = now;
    }
  }, []); // No dependencies, uses refs for latest values

  // --- Serial Connection ---
  const connect = async () => {
    try {
      if (!("serial" in navigator)) {
        throw new Error("Web Serial API not supported in this browser. Please use Chrome, Edge, or Opera.");
      }

      // Check if already connected
      if (port) {
        await disconnect();
      }

      const selectedPort = await (navigator as any).serial.requestPort();
      await selectedPort.open({ baudRate });
      
      setPort(selectedPort);
      setIsConnected(true);
      setError(null);

      // Set up reader
      const textDecoder = new TextDecoderStream();
      const readableStreamClosed = selectedPort.readable.pipeTo(textDecoder.writable);
      const reader = textDecoder.readable.getReader();
      readerRef.current = reader;

      let partialLine = "";
      let lastUpdate = Date.now();
      let bytesAcc = 0;
      
      while (true) {
        try {
          const { value, done } = await reader.read();
          if (done) break;
          
          bytesAcc += value.length;
          
          partialLine += value;
          const lines = partialLine.split("\n");
          partialLine = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) {
              const now = Date.now();
              // Throttle UI update for debug strings
              if (now - lastUpdate > 100) {
                setLastLines(prev => [trimmed, ...prev].slice(0, 5));
                setLastRawString(trimmed);
                setLastDataTimestamp(now);
                setBytesReceived(prev => prev + bytesAcc);
                bytesAcc = 0;
                lastUpdate = now;
              }
              
              // More robust parsing: find the first number in the string
              const match = trimmed.match(/-?\d+/);
              if (match) {
                const num = parseInt(match[0]);
                if (!isNaN(num)) {
                  processNewValue(num);
                }
              }
            }
          }
        } catch (readError: any) {
          console.error("Read error:", readError);
          setError(`Stream error: ${readError.message}`);
          break;
        }
      }
    } catch (err: any) {
      console.error("Connection error:", err);
      if (err.name === "NotFoundError") {
        setError("No device selected.");
      } else if (err.name === "SecurityError") {
        setError("Permission denied. Check if another app is using the port.");
      } else {
        setError(err.message || "Failed to connect to Arduino.");
      }
      setIsConnected(false);
    }
  };

  const disconnect = async () => {
    stopSimulation();
    if (readerRef.current) {
      await readerRef.current.cancel();
      readerRef.current = null;
    }
    if (port) {
      try {
        await port.close();
      } catch (e) {
        console.error("Error closing port:", e);
      }
      setPort(null);
    }
    setIsConnected(false);
    setHistory([]);
    rawDataRef.current = [];
  };

  const startSimulation = () => {
    if (isConnected) disconnect();
    setIsSimulating(true);
    setIsConnected(true);
    
    let lastSimUpdate = Date.now();
    let bytesAcc = 0;

    simulationIntervalRef.current = setInterval(() => {
      // Simulate a 50Hz sine wave + noise
      const t = Date.now() / 1000;
      const base = 512;
      const signal = Math.sin(2 * Math.PI * 50 * t) * 100;
      const noise = (Math.random() - 0.5) * 20;
      const muscle = Math.random() > 0.95 ? (Math.random() * 300) : 0;
      
      const val = Math.round(base + signal + noise + muscle);
      const valStr = val.toString();
      bytesAcc += valStr.length;

      const now = Date.now();
      if (now - lastSimUpdate > 100) {
        setLastDataTimestamp(now);
        setLastRawString(valStr);
        setLastLines(prev => [valStr, ...prev].slice(0, 5));
        setBytesReceived(prev => prev + bytesAcc);
        bytesAcc = 0;
        lastSimUpdate = now;
      }
      
      processNewValue(val);
    }, 2); // 500Hz
  };

  const stopSimulation = () => {
    if (simulationIntervalRef.current) {
      clearInterval(simulationIntervalRef.current);
      simulationIntervalRef.current = null;
    }
    setIsSimulating(false);
  };

  // --- Canvas Oscilloscope ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const draw = () => {
      const w = canvas.width;
      const h = canvas.height;
      
      // Plot area dimensions
      const leftBarWidth = 40;
      const rightBarWidth = 60;
      const plotW = w - leftBarWidth - rightBarWidth;
      
      // Clear canvas
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      
      // Draw grid
      ctx.strokeStyle = "#e0e0e0";
      ctx.lineWidth = 1;
      ctx.beginPath();
      // Vertical grid lines
      for (let i = 0; i <= plotW; i += plotW / 10) {
        ctx.moveTo(leftBarWidth + i, 0); 
        ctx.lineTo(leftBarWidth + i, h);
      }
      // Horizontal grid lines
      for (let i = 0; i <= h; i += h / 8) {
        ctx.moveTo(leftBarWidth, i); 
        ctx.lineTo(leftBarWidth + plotW, i);
      }
      ctx.stroke();

      // Draw zero line (more prominent)
      ctx.strokeStyle = "#c0c0c0";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(leftBarWidth, h / 2);
      ctx.lineTo(leftBarWidth + plotW, h / 2);
      ctx.stroke();

      // Draw Left Bar
      ctx.fillStyle = "#e0e0e0";
      ctx.fillRect(0, 0, leftBarWidth, h);
      
      // "1" box
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, leftBarWidth, 30);
      ctx.fillStyle = "#ff0000";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("1", leftBarWidth / 2, 15);
      
      // "EMG" box
      ctx.fillStyle = "#404040";
      ctx.fillRect(0, 30, leftBarWidth, h - 30);
      ctx.fillStyle = "#ffffff";
      ctx.save();
      ctx.translate(leftBarWidth / 2, h / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.font = "12px sans-serif";
      ctx.fillText("EMG", 0, 0);
      ctx.restore();
      
      // Draw Right Bar
      ctx.fillStyle = "#e4e9ec";
      ctx.fillRect(w - rightBarWidth, 0, rightBarWidth, h);
      
      // Draw borders
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(leftBarWidth, 0); ctx.lineTo(leftBarWidth, h);
      ctx.moveTo(w - rightBarWidth, 0); ctx.lineTo(w - rightBarWidth, h);
      ctx.moveTo(0, 30); ctx.lineTo(leftBarWidth, 30);
      ctx.stroke();

      // Draw Y-Axis Labels
      ctx.fillStyle = "#ff0000";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      
      const labels = ["0.50", "0.00", "-0.50", "-1.00"];
      const yPositions = [h * 0.125, h * 0.5, h * 0.875, h - 10];
      
      labels.forEach((label, index) => {
        ctx.fillText(label, w - rightBarWidth + 5, yPositions[index]);
      });

      // Draw signal
      if (rawDataRef.current.length > 1) {
        ctx.strokeStyle = "#ff0000"; // Red for Raw signal
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        
        const data = rawDataRef.current.slice(-timeWindowRef.current);
        const step = plotW / data.length;
        const g = gainRef.current;
        const scale = (h / 1024) * g;
        
        for (let i = 0; i < data.length; i++) {
          const x = leftBarWidth + (i * step);
          const y = (h / 2) - (data[i] * scale); 
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      animationFrameRef.current = requestAnimationFrame(draw);
    };

    draw();
    return () => {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    };
  }, []);

  // --- RMS Canvas Oscilloscope ---
  useEffect(() => {
    const canvas = rmsCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const draw = () => {
      const w = canvas.width;
      const h = canvas.height;
      
      // Plot area dimensions
      const leftBarWidth = 40;
      const rightBarWidth = 60;
      const plotW = w - leftBarWidth - rightBarWidth;
      
      // Clear canvas
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      
      // Draw grid
      ctx.strokeStyle = "#e0e0e0";
      ctx.lineWidth = 1;
      ctx.beginPath();
      // Vertical grid lines
      for (let i = 0; i <= plotW; i += plotW / 10) {
        ctx.moveTo(leftBarWidth + i, 0); 
        ctx.lineTo(leftBarWidth + i, h - 20); // Leave space for bottom axis
      }
      // Horizontal grid lines
      for (let i = 0; i <= h - 20; i += (h - 20) / 8) {
        ctx.moveTo(leftBarWidth, i); 
        ctx.lineTo(leftBarWidth + plotW, i);
      }
      ctx.stroke();

      // Draw Left Bar
      ctx.fillStyle = "#e0e0e0";
      ctx.fillRect(0, 0, leftBarWidth, h);
      
      // "2" box
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, leftBarWidth, 30);
      ctx.fillStyle = "#0000ff";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("2", leftBarWidth / 2, 15);
      
      // "ARV EMG" box
      ctx.fillStyle = "#e0e0e0";
      ctx.fillRect(0, 30, leftBarWidth, h - 30);
      ctx.fillStyle = "#000000";
      ctx.save();
      ctx.translate(leftBarWidth / 2, (h - 20) / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.font = "12px sans-serif";
      ctx.fillText("ARV EMG (CH 1)", 0, 0);
      ctx.restore();
      
      // Draw Right Bar
      ctx.fillStyle = "#e4e9ec";
      ctx.fillRect(w - rightBarWidth, 0, rightBarWidth, h);
      
      // Draw Bottom Bar
      ctx.fillStyle = "#e4e9ec";
      ctx.fillRect(leftBarWidth, h - 20, plotW, 20);

      // Draw borders
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(leftBarWidth, 0); ctx.lineTo(leftBarWidth, h);
      ctx.moveTo(w - rightBarWidth, 0); ctx.lineTo(w - rightBarWidth, h);
      ctx.moveTo(0, 30); ctx.lineTo(leftBarWidth, 30);
      ctx.moveTo(leftBarWidth, h - 20); ctx.lineTo(leftBarWidth + plotW, h - 20);
      ctx.stroke();

      // Draw Y-Axis Labels
      ctx.fillStyle = "#0000ff";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      
      const labels = ["0.37", "0.25", "0.12", "-0.00"];
      const yPositions = [(h - 20) * 0.125, (h - 20) * 0.375, (h - 20) * 0.625, (h - 20) * 0.875];
      
      labels.forEach((label, index) => {
        ctx.fillText(label, w - rightBarWidth + 5, yPositions[index]);
      });

      // Draw X-Axis Labels
      ctx.fillStyle = "#000000";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      
      const xLabels = ["0.000", "15.000", "30.000", "45.000"];
      const xPositions = [leftBarWidth + 20, leftBarWidth + plotW * 0.33, leftBarWidth + plotW * 0.66, leftBarWidth + plotW - 20];
      
      xLabels.forEach((label, index) => {
        ctx.fillText(label, xPositions[index], h - 10);
      });
      ctx.fillText("seconds", leftBarWidth + plotW / 2, h - 10);

      // Draw signal
      if (history.length > 1) {
        ctx.strokeStyle = "#0000ff"; // Blue for RMS signal
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        
        const data = history;
        const step = plotW / data.length;
        // Scale 0-400 to 0-(h-20)
        const scale = (h - 20) / 400;
        
        for (let i = 0; i < data.length; i++) {
          const x = leftBarWidth + (i * step);
          const val = chartMode === 'rms' ? data[i].rms : data[i].rectified;
          const y = (h - 20) - (val * scale); 
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      rmsAnimationFrameRef.current = requestAnimationFrame(draw);
    };

    draw();
    return () => {
      if (rmsAnimationFrameRef.current) cancelAnimationFrame(rmsAnimationFrameRef.current);
    };
  }, [history, chartMode]);

  // --- Auto-Baseline ---
  const calibrateBaseline = () => {
    if (rawInputRef.current.length > 0) {
      const avg = rawInputRef.current.reduce((a, b) => a + b, 0) / rawInputRef.current.length;
      setBaseline(Math.round(avg));
      // Reset filters to prevent spikes
      lastRawRef.current = 0;
      lastFilteredRef.current = 0;
      notchZ1Ref.current = 0;
      notchZ2Ref.current = 0;
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground font-sans selection:bg-primary/20 selection:text-primary">
      {/* Header */}
      <header className="sticky top-0 z-40 w-full border-b border-border bg-background/90 backdrop-blur-md">
        <div className="container mx-auto px-4 h-16 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div className="futuristic-screen p-2 flex items-center justify-center">
              <Activity className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-foreground font-display">EMG Analyzer Pro</h1>
              <p className="futuristic-label text-primary">Bio-Signal Intelligence Unit v2.0</p>
            </div>
          </div>
          
          <div className="flex items-center gap-3">
            <button 
              onClick={() => window.open(process.env.APP_URL || window.location.href, '_blank')}
              className="hidden md:flex futuristic-button px-3 py-1.5"
              title="Open in new tab for full Serial API support"
            >
              <ExternalLink className="w-3.5 h-3.5" /> Open in New Tab
            </button>
            
            <AnimatePresence>
              {isConnected && (
                <motion.div 
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  className="flex items-center gap-2 px-3 py-1.5 futuristic-screen border-primary/30"
                >
                  <div className={cn(
                    "w-2 h-2 rounded-full transition-all duration-300",
                    Date.now() - lastDataTime < 100 ? "bg-primary scale-125 shadow-[0_0_8px_rgba(59,130,246,0.8)]" : "bg-secondary"
                  )} />
                  <span className="futuristic-label !mb-0 text-primary">Live Stream</span>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="h-8 w-[1px] bg-border mx-1 hidden md:block" />

            {isConnected ? (
              <div className="flex items-center gap-2">
                {isSimulating && (
                  <span className="text-[9px] font-bold text-orange-500 animate-pulse uppercase hidden sm:inline">Simulation Mode</span>
                )}
                <button 
                  onClick={disconnect}
                  className="futuristic-button futuristic-button-danger px-4 py-2"
                >
                  <Square className="w-4 h-4 fill-current" /> {isSimulating ? "Stop Simulation" : "Disconnect"}
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <button 
                  onClick={startSimulation}
                  className="hidden sm:flex futuristic-button px-3 py-2"
                >
                  <Play className="w-3 h-3 fill-current" /> Test Simulation
                </button>
                <div className="relative group">
                  <select 
                    value={baudRate}
                    onChange={(e) => setBaudRate(parseInt(e.target.value))}
                    className="futuristic-input pr-8 appearance-none"
                  >
                    {[9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].map(rate => (
                      <option key={rate} value={rate}>{rate} Baud</option>
                    ))}
                  </select>
                  <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none opacity-50">
                    <ChevronRight className="w-3 h-3 rotate-90" />
                  </div>
                </div>
                <button 
                  onClick={connect}
                  className="futuristic-button futuristic-button-active px-4 py-2"
                >
                  <Play className="w-4 h-4 fill-current" /> Connect
                </button>
              </div>
            )}
            
            <div className="flex items-center gap-1">
              <button 
                onClick={() => {
                  rawDataRef.current = [];
                  rawInputRef.current = [];
                  setHistory([]);
                  setPeakRms(0);
                  peakRmsRef.current = 0;
                  setBytesReceived(0);
                  setLastDataTimestamp(null);
                  setDataRate(0);
                  sumSqRef.current = 0;
                  rmsWindowRef.current = [];
                  lastRawRef.current = 0;
                  lastFilteredRef.current = 0;
                  notchZ1Ref.current = 0;
                  notchZ2Ref.current = 0;
                }}
                className="futuristic-button p-2"
                title="Reset All Data & Filters"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
              <button 
                onClick={() => setShowArduinoCode(!showArduinoCode)}
                className="futuristic-button p-2"
                title="View Arduino Code"
              >
                <Cpu className="w-4 h-4" />
              </button>
              {deferredPrompt && !isPwaInstalled && (
                <button 
                  onClick={handleInstallClick}
                  className="futuristic-button p-2 text-primary animate-bounce"
                  title="Install App"
                >
                  <Download className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Controls & Stats */}
        <div className="lg:col-span-3 space-y-6">
          {/* Status Card */}
          <div className="futuristic-panel p-5">
            <div className="flex items-center gap-2 mb-4">
              <Database className="w-4 h-4 text-primary" />
              <h2 className="futuristic-label !mb-0 text-primary">System Status</h2>
            </div>
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-xs font-medium text-secondary">Connection</span>
                <span className={cn(
                  "futuristic-label !mb-0 px-2 py-1",
                  isConnected ? "bg-primary/10 text-primary border-primary/30" : "bg-destructive/10 text-destructive border-destructive/30"
                )}>
                  {isConnected ? "ONLINE" : "OFFLINE"}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs font-medium text-secondary">Activation</span>
                <span className={cn(
                  "futuristic-label !mb-0 px-2 py-1 transition-all",
                  history[history.length - 1]?.active ? "bg-destructive/20 text-destructive border-destructive/50" : "bg-muted text-muted-foreground border-border"
                )}>
                  {history[history.length - 1]?.active ? "ACTIVE" : "IDLE"}
                </span>
              </div>
            </div>
          </div>

          {/* Configuration */}
          <div className="futuristic-panel p-5 space-y-6">
            <div className="flex items-center gap-2">
              <Settings className="w-4 h-4 text-primary" />
              <h2 className="futuristic-label !mb-0 text-primary">Configuration</h2>
            </div>
            
            <div className="grid grid-cols-3 gap-2 py-4">
              <Knob 
                label="Threshold" 
                value={threshold} 
                min={0} 
                max={200} 
                onChange={setThreshold} 
              />
              <Knob 
                label="Gain" 
                value={gain} 
                min={1} 
                max={20} 
                step={0.5}
                unit="x"
                onChange={setGain} 
              />
              <Knob 
                label="Smooth" 
                value={rmsWindowSize} 
                min={10} 
                max={200} 
                step={5}
                unit="ms"
                onChange={setRmsWindowSize} 
              />
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase font-bold text-secondary">Signal Phase</span>
                <button 
                  onClick={() => setInvert(!invert)}
                  className={cn(
                    "futuristic-button px-3 py-1.5 text-[10px]",
                    invert && "futuristic-button-danger"
                  )}
                >
                  {invert ? "INVERTED" : "NORMAL"}
                </button>
              </div>
            </div>

            <div className="pt-4 border-t border-border space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Layers className="w-3.5 h-3.5 text-primary" />
                  <span className="text-[10px] uppercase font-bold text-secondary">EMG Filters</span>
                </div>
                <button 
                  onClick={() => setFilterEnabled(!filterEnabled)}
                  className={cn(
                    "futuristic-button px-3 py-1.5 text-[10px]",
                    filterEnabled && "futuristic-button-active"
                  )}
                >
                  {filterEnabled ? "ENABLED" : "DISABLED"}
                </button>
              </div>
              
              {filterEnabled && (
                <motion.div 
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="space-y-3"
                >
                  <div className="flex justify-between items-center text-[10px] uppercase font-bold text-secondary">
                    <span>Notch Filter</span>
                    <button 
                      onClick={() => {
                        lastRawRef.current = 0;
                        lastFilteredRef.current = 0;
                        notchZ1Ref.current = 0;
                        notchZ2Ref.current = 0;
                      }}
                      className="text-[8px] hover:text-primary transition-colors opacity-50"
                    >
                      RESET
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {(['none', '50Hz', '60Hz'] as const).map((f) => (
                      <button
                        key={f}
                        onClick={() => setNotchFilter(f)}
                        className={cn(
                          "futuristic-button py-1.5 text-[9px]",
                          notchFilter === f && "futuristic-button-active"
                        )}
                      >
                        {f.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}
            </div>

            <div className="space-y-3 pt-4 border-t border-border">
              <div className="flex justify-between items-center text-[10px] uppercase font-bold text-secondary">
                <span>Vertical Position</span>
                <div className="flex items-center gap-1.5">
                  <button 
                    onClick={() => setBaseline(0)}
                    className="futuristic-button px-2 py-1 text-[8px]"
                  >
                    ZERO
                  </button>
                  <button 
                    onClick={calibrateBaseline}
                    className="futuristic-button futuristic-button-active px-2 py-1 text-[8px]"
                  >
                    CALIBRATE
                  </button>
                </div>
              </div>
              <input 
                type="range" 
                min="0" 
                max="1023" 
                value={baseline} 
                onChange={(e) => setBaseline(parseInt(e.target.value))}
                className="w-full"
              />
              <p className="text-[8px] text-muted-foreground italic text-center">Current: {baseline}</p>
            </div>

            <div className="space-y-3">
              <div className="flex justify-between text-[10px] uppercase font-bold text-secondary">
                <span>Baud Rate</span>
              </div>
              <div className="relative group">
                <select 
                  value={baudRate} 
                  onChange={(e) => setBaudRate(parseInt(e.target.value))}
                  className="futuristic-input w-full pr-8 appearance-none"
                  disabled={isConnected}
                >
                  <option value="9600">9600</option>
                  <option value="19200">19200</option>
                  <option value="38400">38400</option>
                  <option value="57600">57600</option>
                  <option value="115200">115200</option>
                </select>
                <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none opacity-50">
                  <ChevronRight className="w-3 h-3 rotate-90" />
                </div>
              </div>
            </div>

            <div className="pt-4 border-t border-border">
              <button 
                onClick={() => setShowTroubleshooting(true)}
                className="text-[10px] uppercase font-bold flex items-center gap-1.5 text-primary hover:underline"
              >
                <Info className="w-3.5 h-3.5" /> Not connecting?
              </button>
            </div>
          </div>

          {/* Metrics */}
          <div className="futuristic-panel p-5 space-y-4">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-primary" />
              <h2 className="futuristic-label !mb-0 text-primary">Live Metrics</h2>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="futuristic-screen p-3">
                <p className="futuristic-label !mb-1 text-secondary">Current RMS</p>
                <p className="text-2xl font-mono font-bold text-primary">
                  {history[history.length - 1]?.rms.toFixed(1) || "0.0"}
                </p>
              </div>
              <div className="futuristic-screen p-3">
                <div className="flex items-center justify-between mb-1">
                  <p className="futuristic-label !mb-0 text-secondary">Peak RMS</p>
                  <button 
                    onClick={() => { peakRmsRef.current = 0; setPeakRms(0); }}
                    className="futuristic-button p-1 text-primary"
                    title="Reset Peak"
                  >
                    <RefreshCw className="w-2.5 h-2.5" />
                  </button>
                </div>
                <p className="text-2xl font-mono font-bold text-primary">
                  {peakRms.toFixed(1)}
                </p>
              </div>
            </div>
            
            <div className="pt-4 border-t border-border space-y-2">
              <div className="flex justify-between text-[10px] uppercase font-bold text-secondary">
                <span>Sampling Rate</span>
                <span className="font-mono text-foreground">{dataRate} Hz</span>
              </div>
            </div>

            <div className="pt-4 border-t border-border space-y-3">
              <div className="flex justify-between text-[10px] uppercase font-bold text-secondary">
                <span>Last Data Received</span>
                <span className={cn(
                  "font-mono transition-colors",
                  lastDataTimestamp && (Date.now() - lastDataTimestamp > 2000) ? "text-destructive animate-pulse" : "text-foreground"
                )}>
                  {lastDataTimestamp ? `${((Date.now() - lastDataTimestamp) / 1000).toFixed(1)}s ago` : "Never"}
                </span>
              </div>
              {isConnected && lastDataTimestamp && (Date.now() - lastDataTimestamp > 2000) && (
                <div className="futuristic-screen border-destructive/30 p-3">
                  <div className="futuristic-label !mb-1 text-destructive flex items-center gap-1.5">
                    <AlertCircle className="w-3 h-3" /> No data for 2s. Check Baud Rate or Arduino connection.
                  </div>
                  <div className="text-[8px] text-destructive/70 italic">
                    Tip: Try switching to 9600 Baud if 115200 doesn't work.
                  </div>
                </div>
              )}
            </div>

            <div className="pt-4 border-t border-border space-y-3">
              <p className="futuristic-label !mb-0 text-secondary">Raw Range (0-1023)</p>
              <div className="h-2 bg-muted rounded-full overflow-hidden relative border border-border/50">
                {rawDataRef.current.length > 0 && (
                  <div 
                    className="absolute h-full bg-primary transition-all duration-100 opacity-60"
                    style={{ 
                      left: `${Math.max(0, Math.min(...rawDataRef.current.map(v => v + baselineRef.current)) / 10.24)}%`,
                      right: `${Math.max(0, 100 - (Math.max(...rawDataRef.current.map(v => v + baselineRef.current)) / 10.24))}%`
                    }}
                  />
                )}
              </div>
              <div className="flex justify-between text-[8px] text-muted-foreground font-mono font-bold">
                <span>{rawDataRef.current.length > 0 ? Math.min(...rawDataRef.current.map(v => v + baselineRef.current)).toFixed(0) : 0}</span>
                <span>{rawDataRef.current.length > 0 ? Math.max(...rawDataRef.current.map(v => v + baselineRef.current)).toFixed(0) : 1023}</span>
              </div>
            </div>

            <div className="pt-4 border-t border-border space-y-3">
              <div className="flex justify-between text-[10px] uppercase font-bold text-secondary">
                <span>Live Input (A0)</span>
                <span className="font-mono text-foreground">{rawInputRef.current[rawInputRef.current.length - 1] || 0}</span>
              </div>
              <div className="h-1.5 bg-muted rounded-full overflow-hidden relative border border-border/50">
                <div 
                  className="absolute h-full bg-primary transition-all duration-75"
                  style={{ width: `${(rawInputRef.current[rawInputRef.current.length - 1] || 0) / 10.24}%` }}
                />
              </div>
            </div>

            <div className="pt-4 border-t border-border space-y-3">
              <div className="flex justify-between text-[10px] uppercase font-bold text-secondary">
                <span>Data Received</span>
                <span className="font-mono text-foreground">{bytesReceived.toLocaleString()} chars</span>
              </div>
              <p className="text-[8px] text-muted-foreground italic">Total characters read from serial port.</p>
            </div>

            <div className="pt-4 border-t border-border space-y-3">
              <div className="flex justify-between text-[10px] uppercase font-bold text-secondary">
                <span>Last Raw String</span>
                <span className="font-mono text-primary font-bold">{lastRawString}</span>
              </div>
              <p className="text-[8px] text-muted-foreground italic">Shows the raw text coming from your Arduino.</p>
            </div>

            <div className="pt-4 border-t border-border space-y-3">
              <div className="flex justify-between text-[10px] uppercase font-bold text-secondary">
                <span>Serial Monitor (Last 5)</span>
              </div>
              <div className="futuristic-screen p-3 font-mono text-[9px] space-y-1.5">
                {lastLines.length > 0 ? lastLines.map((l, i) => (
                  <div key={i} className={cn(
                    "truncate",
                    i === 0 ? "text-primary font-bold" : "opacity-60"
                  )}>{l}</div>
                )) : <div className="opacity-30 italic">Waiting for data...</div>}
              </div>
            </div>

            <div className="pt-4 border-t border-border space-y-3">
              <div className="flex justify-between text-[10px] uppercase font-bold text-secondary">
                <span>Time Window (Zoom)</span>
                <span className="font-mono text-foreground">{timeWindow} pts</span>
              </div>
              <input 
                type="range" 
                min="200" 
                max="2000" 
                step="100"
                value={timeWindow} 
                onChange={(e) => setTimeWindow(parseInt(e.target.value))}
                className="w-full"
              />
              <p className="text-[8px] text-muted-foreground italic">Larger window = more history visible, slower scroll.</p>
            </div>

            <div className="pt-4 border-t border-border space-y-3">
              <div className="flex items-center justify-between">
                <p className="futuristic-label !mb-0 text-secondary">Chart Scale</p>
                <button 
                  onClick={() => setUseFixedScale(!useFixedScale)}
                  className={cn(
                    "futuristic-button px-3 py-1 text-[9px]",
                    useFixedScale && "futuristic-button-active"
                  )}
                >
                  {useFixedScale ? 'Fixed (0-400)' : 'Auto'}
                </button>
              </div>
              <p className="text-[8px] text-muted-foreground italic">
                {useFixedScale ? 'Y-axis locked to 0-400 for stability.' : 'Y-axis adjusts to signal peak.'}
              </p>
            </div>

            <div className="pt-4 border-t border-border space-y-3">
              <div className="flex items-center justify-between">
                <p className="futuristic-label !mb-0 text-secondary">Chart Mode</p>
                <div className="flex bg-muted p-1 rounded-xl border border-border/50">
                  {(['rms', 'rectified'] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => setChartMode(m)}
                      className={cn(
                        "futuristic-button px-3 py-1 text-[8px]",
                        chartMode === m && "futuristic-button-active"
                      )}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-[8px] text-muted-foreground italic">
                {chartMode === 'rms' ? 'Root Mean Square (Smoothed)' : 'Rectified (Mean Absolute Value)'}
              </p>
            </div>
          </div>
        </div>

        {/* Right Column: Visualizations */}
        <div className="lg:col-span-9 flex flex-col border border-black overflow-hidden bg-white">
          {/* Raw Oscilloscope */}
          <div className="w-full h-[400px] relative border-b border-black">
            <canvas 
              ref={canvasRef} 
              width={1600} 
              height={500} 
              className="w-full h-full cursor-crosshair"
            />
            {!isConnected && (
              <div className="absolute inset-0 flex items-center justify-center bg-background/80 backdrop-blur-sm">
                <div className="text-center space-y-2">
                  <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center mx-auto">
                    <Activity className="w-5 h-5 text-muted-foreground opacity-20" />
                  </div>
                  <p className="futuristic-label !mb-0 text-muted-foreground">Waiting for connection...</p>
                </div>
              </div>
            )}
          </div>

          {/* RMS Envelope Chart */}
          <div className="w-full h-[400px] relative">
            <canvas 
              ref={rmsCanvasRef} 
              width={1600} 
              height={500} 
              className="w-full h-full cursor-crosshair"
            />
            {!isConnected && (
              <div className="absolute inset-0 flex items-center justify-center bg-background/80 backdrop-blur-sm">
                <div className="text-center space-y-2">
                  <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center mx-auto">
                    <Layers className="w-5 h-5 text-muted-foreground opacity-20" />
                  </div>
                  <p className="futuristic-label !mb-0 text-muted-foreground">Waiting for connection...</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Arduino Code Modal */}
      <AnimatePresence>
        {showArduinoCode && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-foreground/80 backdrop-blur-md z-50 flex items-center justify-center p-6"
          >
            <motion.div 
              initial={{ scale: 0.95, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 20 }}
              className="futuristic-panel max-w-2xl w-full p-8 space-y-6"
            >
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-3">
                  <div className="futuristic-screen p-2">
                    <Database className="w-5 h-5 text-primary" />
                  </div>
                  <h2 className="text-2xl font-display font-bold tracking-tight text-foreground">Arduino Setup</h2>
                </div>
                <button 
                  onClick={() => setShowArduinoCode(false)} 
                  className="futuristic-button p-2"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            
            <div className="space-y-4">
              <p className="text-sm text-secondary font-medium">Upload this code to your Arduino to start streaming EMG data from pin A0.</p>
              <div className="futuristic-screen p-5 font-mono text-xs overflow-x-auto relative group">
                <pre className="leading-relaxed">{`void setup() {
  Serial.begin(${baudRate});
}

void loop() {
  // Read EMG signal from Analog Pin 0
  int val = analogRead(A0);
  
  // Send to Serial
  Serial.println(val);
  
  // ~500Hz sampling rate
  delay(2); 
}`}</pre>
                <button 
                  className="absolute top-4 right-4 futuristic-button p-2 opacity-0 group-hover:opacity-100 flex items-center gap-2"
                  onClick={() => navigator.clipboard.writeText(`void setup() {\n  Serial.begin(${baudRate});\n}\n\nvoid loop() {\n  int val = analogRead(A0);\n  Serial.println(val);\n  delay(2); \n}`)}
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span className="text-[10px] font-bold uppercase">Copy</span>
                </button>
              </div>
              <div className="flex items-start gap-3 p-4 futuristic-screen">
                <Info className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                <div className="text-[10px] text-secondary font-medium space-y-1">
                  <p><strong className="text-primary uppercase">Baud Rate:</strong> {baudRate}</p>
                  <p><strong className="text-primary uppercase">Wiring:</strong> Connect EMG Module OUT to Arduino A0, GND to GND, and VCC to 5V.</p>
                  <p><strong className="text-primary uppercase">Web Serial:</strong> Ensure you are using Chrome, Edge, or Opera.</p>
                </div>
              </div>
            </div>
            
            <div className="pt-4 flex justify-end">
              <button 
                onClick={() => setShowArduinoCode(false)}
                className="futuristic-button futuristic-button-active px-6 py-2.5"
              >
                Got it
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>

      {/* Troubleshooting Modal */}
      <AnimatePresence>
        {showTroubleshooting && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-foreground/80 backdrop-blur-md z-50 flex items-center justify-center p-6"
          >
            <motion.div 
              initial={{ scale: 0.95, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 20 }}
              className="futuristic-panel max-w-2xl w-full p-8 space-y-6"
            >
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-3">
                  <div className="futuristic-screen p-2">
                    <Info className="w-5 h-5 text-primary" />
                  </div>
                  <h2 className="text-2xl font-display font-bold tracking-tight text-foreground">Troubleshooting</h2>
                </div>
                <button 
                  onClick={() => setShowTroubleshooting(false)} 
                  className="futuristic-button p-2"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {[
                  {
                    title: "1. Open in a New Tab",
                    desc: "Web Serial can sometimes be blocked inside an iframe. Click the \"Open in new tab\" button at the top right of the AI Studio preview to run the app directly."
                  },
                  {
                    title: "2. Close Serial Monitor",
                    desc: "Ensure the Arduino IDE Serial Monitor is closed. Only one application can access the serial port at a time."
                  },
                  {
                    title: "3. Check Browser",
                    desc: "Web Serial is only supported in Chrome, Edge, and Opera. Firefox and Safari do not support this feature."
                  },
                  {
                    title: "4. Check Baud Rate",
                    desc: `Ensure the baud rate in the app matches the Serial.begin() value in your Arduino code (default is ${baudRate}).`
                  }
                ].map((item, i) => (
                  <div key={i} className="futuristic-screen p-4 space-y-2">
                    <p className="futuristic-label !mb-0 text-primary">{item.title}</p>
                    <p className="text-xs text-secondary leading-relaxed">{item.desc}</p>
                  </div>
                ))}
              </div>
              
              <button 
                onClick={() => setShowTroubleshooting(false)}
                className="futuristic-button futuristic-button-active w-full py-3"
              >
                Got it
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Error Toast */}
      <AnimatePresence>
        {error && (
          <motion.div 
            initial={{ opacity: 0, y: 50, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.9 }}
            className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50 flex items-center gap-4 bg-destructive text-destructive-foreground px-6 py-4 rounded-2xl shadow-2xl shadow-destructive/20 border border-white/10"
          >
            <div className="p-2 bg-white/20 rounded-xl">
              <AlertCircle className="w-5 h-5" />
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] font-bold uppercase tracking-widest opacity-70">Error Detected</span>
              <span className="text-sm font-medium">{error}</span>
            </div>
            <button 
              onClick={() => setError(null)} 
              className="ml-4 p-2 hover:bg-white/10 rounded-xl transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Footer */}
      <footer className="border-t border-border p-8 flex flex-col md:flex-row justify-between items-center gap-6 bg-background">
        <div className="flex items-center gap-4">
          <div className="futuristic-screen p-2">
            <Activity className="w-4 h-4 text-primary" />
          </div>
          <p className="futuristic-label !mb-0 text-secondary">
            © 2026 Signal Analysis Systems <span className="mx-2 opacity-30">|</span> EMG Analyzer v2.0
          </p>
        </div>
        <div className="flex items-center gap-6">
          <button className="flex items-center gap-2 futuristic-label !mb-0 text-secondary hover:text-primary transition-colors">
            <Terminal className="w-3.5 h-3.5" />
            <span>Terminal</span>
          </button>
          <button className="flex items-center gap-2 futuristic-label !mb-0 text-secondary hover:text-primary transition-colors">
            <Settings className="w-3.5 h-3.5" />
            <span>Settings</span>
          </button>
          <div className="h-4 w-px bg-border mx-2" />
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
            <span className="futuristic-label !mb-0 text-primary">System Online</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
