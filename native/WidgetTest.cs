using System;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Passive, explicitly synthetic destination for manual widget integration checks.
class WidgetTest
{
    [STAThread] static void Main()
    {
        Application.EnableVisualStyles();
        var form = new Form { Text = "QuillKey widget test target", Width = 720, Height = 420 };
        var box = new TextBox { Multiline = true, AcceptsReturn = true, AcceptsTab = true,
            Dock = DockStyle.Fill, ScrollBars = ScrollBars.Vertical };
        var json = new JavaScriptSerializer();
        box.TextChanged += delegate {
            Console.WriteLine(json.Serialize(new { type = "widget-test-text", text = box.Text }));
            Console.Out.Flush();
        };
        form.Controls.Add(box);
        form.Shown += delegate { box.Focus(); };
        Console.WriteLine("{\"type\":\"widget-test-ready\"}");
        Console.Out.Flush();
        Application.Run(form);
    }
}
