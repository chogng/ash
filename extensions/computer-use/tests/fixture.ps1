$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
$window = [System.Windows.Window]::new()
$window.Title = 'Ash Computer Use fixture ' + $PID
$window.ShowActivated = $false
$window.ShowInTaskbar = $false
$window.Width = 320
$window.Height = 150
$panel = [System.Windows.Controls.StackPanel]::new()
$edit = [System.Windows.Controls.TextBox]::new()
[System.Windows.Automation.AutomationProperties]::SetName($edit, 'Test value')
$button = [System.Windows.Controls.Button]::new()
$button.Content = 'Apply test value'
$result = [System.Windows.Controls.TextBlock]::new()
$result.Text = 'Awaiting test value'
$button.Add_Click({ $result.Text = 'Applied: ' + $edit.Text })
$null = $panel.Children.Add($edit)
$null = $panel.Children.Add($button)
$null = $panel.Children.Add($result)
$window.Content = $panel
$window.Add_ContentRendered({
    [Console]::WriteLine('ready')
    [Console]::Out.Flush()
})
$timer = [System.Windows.Threading.DispatcherTimer]::new()
$timer.Interval = [TimeSpan]::FromSeconds(150)
$timer.Add_Tick({ $timer.Stop(); $window.Close() })
$timer.Start()
$null = $window.ShowDialog()
