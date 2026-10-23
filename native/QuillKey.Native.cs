using System;
using System.Windows.Automation;
using System.Collections.Generic;
using System.IO;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
class Bridge : Form
{
    JavaScriptSerializer j = new JavaScriptSerializer();
    System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    IntPtr window, focus;
    uint pid;
    string token;
    string automationTarget;
    bool held, active, busy, registered;
    long sequence;
    uint lastRestoredClipboardSequence;
    System.Windows.Forms.Timer pendingTimer;
    string pendingId, pendingText, pendingToken;
    DateTime pendingDeadline;
    Action<object> testObserver;

    static bool ModifiersHeld()
    {
        return Down(17) || Down(18) || Down(16) || Down(91) || Down(92) || Down(32);
    }

    void CancelPending()
    {
        if (pendingTimer == null) return;
        pendingTimer.Stop();
        pendingTimer.Dispose();
        pendingTimer = null;
        string id = pendingId;
        pendingId = pendingText = pendingToken = null;
        Result(id, false, "cancelled");
    }

    void QueueInsert(string id, string text)
    {
        if (busy || pendingTimer != null)
        {
            Result(id, false, "insertion-busy");
            return;
        }
        pendingId = id;
        pendingText = text;
        pendingToken = token;
        pendingDeadline = DateTime.UtcNow.AddSeconds(2);
        pendingTimer = new System.Windows.Forms.Timer();
        pendingTimer.Interval = 25;
        pendingTimer.Tick += delegate { TryPendingInsert(); };
        pendingTimer.Start();
        TryPendingInsert();
    }

    void TryPendingInsert()
    {
        if (pendingTimer == null) return;
        if (pendingToken != token || token == null)
        {
            CancelPending();
            return;
        }
        if (Down(27))
        {
            held = active = false;
            token = null;
            CancelPending();
            Emit(new { type = "cancel" });
            return;
        }
        if (ModifiersHeld() && DateTime.UtcNow < pendingDeadline) return;
        string id = pendingId, text = pendingText;
        pendingTimer.Stop();
        pendingTimer.Dispose();
        pendingTimer = null;
        pendingId = pendingText = pendingToken = null;
        Insert(id, text);
    }
    [StructLayout(LayoutKind.Sequential)]struct GUI
    {
        public int size;
        public uint flags;
        public IntPtr active, focus, capture, menu, move, caret;
        public Rectangle rect;
    }
    [StructLayout(LayoutKind.Sequential)]struct INPUT
    {
        public uint type;
        public UNION data;
    }
    [StructLayout(LayoutKind.Explicit)]struct UNION
    {
        [FieldOffset(0)]public KEY key;
        [FieldOffset(0)]public MOUSE mouse;
    }
    [StructLayout(LayoutKind.Sequential)]struct KEY
    {
        public ushort vk, scan;
        public uint flags, time;
        public UIntPtr extra;
    }
    [StructLayout(LayoutKind.Sequential)]struct MOUSE
    {
        public int x, y;
        public uint data, flags, time;
        public UIntPtr extra;
    }
    [DllImport("user32.dll")]static extern bool RegisterHotKey(IntPtr h, int id, uint mod, uint key);
    [DllImport("user32.dll")]static extern bool UnregisterHotKey(IntPtr h, int id);
    [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
    [DllImport("user32.dll")]static extern bool GetGUIThreadInfo(uint t, ref GUI g);
    [DllImport("user32.dll")]static extern short GetAsyncKeyState(int k);
    [DllImport("user32.dll")]static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")]static extern uint SendInput(uint n, INPUT[] a, int size);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")]static extern int GetWindowLong(IntPtr h, int index);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int max);
    static bool Down(int k)
    {
        return(GetAsyncKeyState(k)&0x8000) != 0;
    }
    void Emit(object o)
    {
        if (testObserver != null) testObserver(o);
        Console.WriteLine(j.Serialize(o));
        Console.Out.Flush();
    }
    void Result(string id, bool ok, string reason)
    {
        Emit(new
        {
            type = "insert-result", id = id, ok = ok, reason = reason
        }
        );
    }
    // Capture both HWND focus and UI Automation identity for browser inputs sharing an HWND.
    bool CaptureTarget()
    {
        window = GetForegroundWindow();
        uint t = GetWindowThreadProcessId(window, out pid);
        GUI g = new GUI();
        g.size = Marshal.SizeOf(g);
        if (window == IntPtr.Zero || !GetGUIThreadInfo(t, ref g) || g.focus == IntPtr.Zero)return false;
        focus = g.focus;
        automationTarget = FocusedAutomationId();
        token = Guid.NewGuid().ToString("N");
        return true;
    }
    bool Matches()
    {
        if (window != GetForegroundWindow())return false;
        uint p;
        uint t = GetWindowThreadProcessId(window, out p);
        GUI g = new GUI();
        g.size = Marshal.SizeOf(g);
        return p == pid && GetGUIThreadInfo(t, ref g) && g.focus == focus && (automationTarget == null || automationTarget == FocusedAutomationId());
    }
    static string FocusedAutomationId()
    {
        try
        {
            var element = AutomationElement.FocusedElement;
            if (element == null)return null;
            return string.Join("-", Array.ConvertAll(element.GetRuntimeId(), x => x.ToString()));
        }
        catch
        {
            return null;
        }
    }
    bool Password()
    {
        try
        {
            var element = AutomationElement.FocusedElement;
            if (element != null && element.Current.IsPassword)return true;
        }
        catch
        {
            return true;
        }
        var s = new System.Text.StringBuilder(256);
        GetClassName(focus, s, 256);
        return s.ToString().IndexOf("Edit", StringComparison.OrdinalIgnoreCase) >= 0 && ((GetWindowLong(focus, -16)&0x20) != 0 || SendMessage(focus, 0xD2, IntPtr.Zero, IntPtr.Zero) != IntPtr.Zero);
    }
    // Materialize every native format before replacing clipboard contents. Never discard unknown data.
    static DataObject Snapshot()
    {
        IDataObject old = Clipboard.GetDataObject();
        DataObject saved = new DataObject();
        if (old == null)return saved;
        foreach (string f in old.GetFormats(false))
        {
            object v = old.GetData(f, false);
            if (v == null)throw new Exception();
            if (v is MemoryStream)v = new MemoryStream(((MemoryStream)v).ToArray());
            else if (v is Bitmap)v = ((Bitmap)v).Clone();
            else if (v is byte[])v = ((byte[])v).Clone();
            else if (v is string[])v = ((string[])v).Clone();
            else if (!(v is string) && !(v is int) && !(v is long) && !(v is bool))throw new Exception();
            saved.SetData(f, false, v);
        }
        return saved;
    }
    void Restore(DataObject saved)
    {
        if (saved.GetFormats(false).Length == 0)Clipboard.Clear();
        else Clipboard.SetDataObject(saved, true);
    }
    void Insert(string id, string text)
    {
        if (busy)
        {
            Result(id, false,"insertion-busy");
            return;
        }
        if (ModifiersHeld())
        {
            Result(id, false,"modifiers-held");
            return;
        }
        if (!Matches())
        {
            Result(id, false,"focus-changed");
            return;
        }
        if (Password())
        {
            Result(id, false,"password-field");
            return;
        }
        uint beforeSnapshot = GetClipboardSequenceNumber();
        DataObject saved;
        try
        {
            saved = Snapshot();
            if (GetClipboardSequenceNumber() != beforeSnapshot)
            {
                Result(id, false, "clipboard-changed-during-snapshot");
                return;
            }
        }
        catch (Exception error)
        {
            Emit(new
            {
                type = "diagnostic", code = "clipboard-snapshot-failed", errorType = error.GetType().Name
            }
            );
            Result(id, false,"clipboard-snapshot-failed");
            return;
        }
        bool changed = false;
        try
        {
            Clipboard.SetText(text, TextDataFormat.UnicodeText);
            sequence = GetClipboardSequenceNumber();
            changed = true;
            if (!Matches())
            {
                if (GetClipboardSequenceNumber() == sequence) Restore(saved);
                Result(id, false,"focus-changed");
                return;
            }
            INPUT[] a = new INPUT[4];
            ushort[] keys = {
                17, 86, 86, 17
            }
            ;
            for (int i = 0;i<4;i++)
            {
                a[i].type = 1;
                a[i].data.key.vk = keys[i];
                a[i].data.key.flags = i >= 2?2u:0u;
            }
            // A paste is sent once; a successful SendInput does not prove the target consumed it.
            uint sent = SendInput(4, a, Marshal.SizeOf(typeof(INPUT)));
            token = null;
            if (sent != 4)
            {
                INPUT[] release = new INPUT[2];
                for (int n = 0;n<2;n++)
                {
                    release[n].type = 1;
                    release[n].data.key.vk = n == 0?(ushort)86:(ushort)17;
                    release[n].data.key.flags = 2;
                }
                SendInput(2, release, Marshal.SizeOf(typeof(INPUT)));
            }
            busy = true;
            var restore = new System.Windows.Forms.Timer();
            restore.Interval = 600;
            restore.Tick+= delegate
            {
                restore.Stop();
                restore.Dispose();
                bool restored = false;
                try
                {
                    if (GetClipboardSequenceNumber() == sequence)
                    {
                        Restore(saved);
                        lastRestoredClipboardSequence = GetClipboardSequenceNumber();
                        restored = true;
                    }
                }
                catch
                {
                }
                busy = false;
                Result(id, sent == 4, sent != 4?"input-blocked":restored?"paste-sent-clipboard-restored":"paste-sent-clipboard-changed");
            }
            ;
            restore.Start();
        }
        catch
        {
            if (changed)try
            {
                if (GetClipboardSequenceNumber() == sequence)Restore(saved);
            }
            catch
            {
            }
            Result(id, false,"clipboard-unavailable");
        }
    }
    void Command(string line)
    {
        string id = "";
        try
        {
            if (line.Length>200000)return;
            var c = j.Deserialize<Dictionary<string, object>>(line);
            string type = Convert.ToString(c["type"]);
            if (type == "quit")
            {
                Close();
                return;
            }
            if (type == "active")
            {
                active = Convert.ToBoolean(c["value"]);
                if (!active)
                {
                    held = false;
                    token = null;
                    CancelPending();
                }
                return;
            }
            if (type != "insert")return;
            id = Convert.ToString(c["id"]);
            string text = Convert.ToString(c["text"]);
            var t = c["target"] as Dictionary<string, object>;
            if (t == null || token == null || Convert.ToString(t["token"]) != token)
            {
                Result(id, false,"invalid-target");
                return;
            }
            if (text.Length == 0 || text.Length>100000)
            {
                Result(id, false,"invalid-text-length");
                return;
            }
            QueueInsert(id, text);
        }
        catch
        {
            Result(id, false,"invalid-command");
        }
    }
    Bridge(bool test)
    {
        ShowInTaskbar = test;
        Text = "QuillKey native self-test";
        Width = 420;
        Height = 150;
        if (!test)
        {
            Opacity = 0;
            WindowState = FormWindowState.Minimized;
        }
        timer.Interval = 25;
        timer.Tick+= delegate
        {
            if ((held || active) && Down(27))
            {
                held = false;
                active = false;
                token = null;
                CancelPending();
                Emit(new
                {
                    type = "cancel"
                }
                );
            }
            else if (held && (!Down(32) || !Down(17) || !Down(18)))
            {
                held = false;
                Emit(new
                {
                    type = "release"
                }
                );
            }
        }
        ;
        Shown+= delegate
        {
            if (test)
            {
                SelfTest();
                return;
            }
            timer.Start();
            registered = RegisterHotKey(Handle, 1, 0x4003, 32);
            Emit(new
            {
                type = "ready", ok = registered, hotkey = "Ctrl+Alt+Space", reason = registered?"ready":"hotkey-unavailable"
            }
            );
            new Thread(() => {
                string line;while ((line = Console.ReadLine()) != null)
                {
                    string copy = line;try
                    {
                        BeginInvoke((Action)(() => Command(copy)));
                    }
                    catch
                    {
                        return;
                    }
                }
                try
                {
                    BeginInvoke((Action)(() => Close()));
                }
                catch
                {
                }
            }
            )
            {
                IsBackground = true
            }
            .Start();
            Hide();
        }
        ;
        FormClosed+= delegate
        {
            if (registered)UnregisterHotKey(Handle, 1);
        }
        ;
    }
    protected override void WndProc(ref Message m)
    {
        if (m.Msg == 0x312 && !held && !active && !busy && pendingTimer == null && CaptureTarget())
        {
            held = true;
            active = true;
            Emit(new
            {
                type = "press", target = new
                {
                    token = token
                }
            }
            );
        }
        base.WndProc(ref m);
    }
    static bool passed;
    void SelfTest()
    {
        var box = new TextBox();
        box.Dock = DockStyle.Fill;
        Controls.Add(box);
        Activate();
        SetForegroundWindow(Handle);
        box.Focus();
        int ticks = 0;
        string phase = "start";
        uint originalSequence = GetClipboardSequenceNumber();
        long sentinelSequence = -1;
        DataObject original = null;
        try
        {
            original = Snapshot();
        }
        catch (Exception error)
        {
            Emit(new
            {
                type = "self-test", ok = false, reason = "clipboard-snapshot-failed", errorType = error.GetType().Name
            }
            );
            Close();
            return;
        }
        var t = new System.Windows.Forms.Timer();
        t.Interval = 50;
        t.Tick+= delegate
        {
            ticks++;
            if (phase == "start" && ticks>5)
            {
                if (GetForegroundWindow() != Handle || !box.Focused)
                {
                    if (ticks>1200)
                    {
                        Emit(new
                        {
                            type = "self-test", ok = false, reason = "test-window-not-focused"
                        }
                        );
                        t.Stop();
                        Close();
                    }
                    return;
                }
                if (GetClipboardSequenceNumber() != originalSequence)
                {
                    Emit(new { type = "self-test", ok = false, reason = "clipboard-changed-before-test" });
                    t.Stop(); Close(); return;
                }
                Clipboard.SetText("QuillKey clipboard sentinel");
                sentinelSequence = GetClipboardSequenceNumber();
                CaptureTarget();
                Insert("self-test","QuillKey paste verified");
                phase = "verify";
                ticks = 0;
            }
            else if (phase == "verify" && ticks>25)
            {
                bool paste = box.Text == "QuillKey paste verified";
                bool restored = Clipboard.ContainsText() && Clipboard.GetText() == "QuillKey clipboard sentinel";
                var other = new TextBox();
                Controls.Add(other);
                other.BringToFront();
                other.Focus();
                bool refused = !Matches();
                passed = paste && restored && refused;
                try
                {
                    if ((GetClipboardSequenceNumber() == sentinelSequence) ||
                        (lastRestoredClipboardSequence != 0 && GetClipboardSequenceNumber() == lastRestoredClipboardSequence)) Restore(original);
                }
                catch
                {
                }
                Emit(new
                {
                    type = "self-test", ok = passed, paste = paste, clipboardRestored = restored, focusChangeRefused = refused
                }
                );
                t.Stop();
                Close();
            }
        }
        ;
        t.Start();
    }
    static int LogicTest()
    {
        // No window is shown and no clipboard, hotkey, or global input API is called.
        var bridge = new Bridge(true);
        var events = new List<Dictionary<string, object>>();
        bridge.testObserver = value => events.Add(bridge.j.Deserialize<Dictionary<string, object>>(bridge.j.Serialize(value)));
        bridge.Command("{\"type\":\"insert\",\"id\":\"bad-target\",\"text\":\"test\",\"target\":{\"token\":\"stale\"}}");
        bool invalidTarget = events.Count == 1 && Convert.ToString(events[0]["reason"]) == "invalid-target";
        bridge.token = "current";
        bridge.Command("{\"type\":\"insert\",\"id\":\"empty\",\"text\":\"\",\"target\":{\"token\":\"current\"}}");
        bool emptyRefused = Convert.ToString(events[events.Count - 1]["reason"]) == "invalid-text-length";
        bridge.pendingId = "cancel-test";
        bridge.pendingText = "must never paste";
        bridge.pendingToken = "current";
        bridge.pendingTimer = new System.Windows.Forms.Timer();
        bridge.held = bridge.active = true;
        bridge.Command("{\"type\":\"active\",\"value\":false}");
        bool cancelled = bridge.token == null && !bridge.held && !bridge.active && bridge.pendingTimer == null &&
            Convert.ToString(events[events.Count - 1]["reason"]) == "cancelled";
        bridge.TryPendingInsert();
        bool noPendingExecution = events.Count == 3;
        bridge.Command("not json");
        bool malformedRefused = Convert.ToString(events[events.Count - 1]["reason"]) == "invalid-command";
        bool ok = invalidTarget && emptyRefused && cancelled && noPendingExecution && malformedRefused;
        bridge.Emit(new { type = "logic-test", ok = ok, invalidTarget = invalidTarget,
            emptyRefused = emptyRefused, pendingCancelled = cancelled,
            noPendingExecution = noPendingExecution, malformedRefused = malformedRefused });
        bridge.Dispose();
        return ok ? 0 : 1;
    }
    [STAThread]static int Main(string[] args)
    {
        if (Array.IndexOf(args, "--logic-test") >= 0) return LogicTest();
        bool test = Array.IndexOf(args,"--self-test") >= 0;
        Application.EnableVisualStyles();
        Application.Run(new Bridge(test));
        return test && !passed?1:0;
    }
}



