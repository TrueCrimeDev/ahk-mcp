# YOLO Mode - Auto-Approve All AHK Tools

Backup of Claude Code settings with all AHK MCP tools auto-approved.

## Settings JSON

```json
{
  "globalShortcut": "Alt+Ctrl+Space",
  "mcpServers": {
    "ahk-server": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\Users\\uphol\\Documents\\Design\\Coding\\ahk-mcp\\dist\\index.js"
      ],
      "env": {
        "NODE_ENV": "production",
        "AHK_MCP_LOG_LEVEL": "debug"
      },
      "alwaysAllow": [
        "AHK_Active_File",
        "AHK_Alpha",
        "AHK_Analyze",
        "AHK_Analyze_Unified",
        "AHK_Analytics",
        "AHK_Cloud_Validate",
        "AHK_Config",
        "AHK_Context_Injector",
        "AHK_Debug_Agent",
        "AHK_Diagnostics",
        "AHK_Doc_Search",
        "AHK_File_Active",
        "AHK_File_Create",
        "AHK_File_Detect",
        "AHK_File_Edit",
        "AHK_File_Edit_Advanced",
        "AHK_File_Edit_Diff",
        "AHK_File_Edit_Small",
        "AHK_File_List",
        "AHK_File_Recent",
        "AHK_File_View",
        "AHK_Library_Import",
        "AHK_Library_Info",
        "AHK_Library_List",
        "AHK_Library_Search",
        "AHK_Lint",
        "AHK_LSP",
        "AHK_Memory_Context",
        "AHK_Process_Request",
        "AHK_Prompts",
        "AHK_Run",
        "AHK_Sampling_Enhancer",
        "AHK_Settings",
        "AHK_Smart_Orchestrator",
        "AHK_Summary",
        "AHK_Test_Interactive",
        "AHK_THQBY_Document_Symbols",
        "AHK_Tools_Search",
        "AHK_Trace_Viewer",
        "AHK_VSCode_Open",
        "AHK_VSCode_Problems",
        "AHK_Workflow_Analyze_Fix_Run"
      ]
    }
  }
}
```

## Tools Included (42 total)

| Category      | Tools                                                                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **File**      | Active_File, File_Active, File_Create, File_Detect, File_Edit, File_Edit_Advanced, File_Edit_Diff, File_Edit_Small, File_List, File_Recent, File_View |
| **Analysis**  | Analyze, Analyze_Unified, Diagnostics, Lint, LSP, Smart_Orchestrator, Summary, THQBY_Document_Symbols, VSCode_Problems                                |
| **Execution** | Debug_Agent, Process_Request, Run, Test_Interactive                                                                                                   |
| **Docs**      | Context_Injector, Doc_Search, Prompts, Sampling_Enhancer                                                                                              |
| **Library**   | Library_Import, Library_Info, Library_List, Library_Search                                                                                            |
| **System**    | Alpha, Analytics, Cloud_Validate, Config, Memory_Context, Settings, Tools_Search, Trace_Viewer, VSCode_Open, Workflow_Analyze_Fix_Run                 |

---

_Generated: 2026-01-11_
