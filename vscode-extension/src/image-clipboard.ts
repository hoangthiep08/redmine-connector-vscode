import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { Attachment, fetchAttachmentAsDataUrl, isImageAttachment } from "./redmine-client";

const execFileAsync = promisify(execFile);

export async function copyImageToClipboard(attachment: Attachment): Promise<void> {
  if (!isImageAttachment(attachment)) {
    vscode.window.showWarningMessage(`${attachment.filename} is not an image.`);
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Copying ${attachment.filename}...` },
    async () => {
      const dataUrl = await fetchAttachmentAsDataUrl(attachment.content_url);
      const base64 = dataUrl.split(",")[1];
      const buf = Buffer.from(base64, "base64");

      // Write to temp file
      const ext = guessExt(attachment.content_type);
      const tmpFile = path.join(os.tmpdir(), `redmine_${attachment.id}${ext}`);
      fs.writeFileSync(tmpFile, buf);

      const platform = process.platform;

      if (platform === "darwin") {
        await copyMacOS(tmpFile, attachment.content_type);
      } else if (platform === "win32") {
        await copyWindows(tmpFile);
      } else {
        await copyLinux(tmpFile);
      }

      fs.unlinkSync(tmpFile);
    }
  );

  vscode.window.showInformationMessage(
    `Image copied! Paste into Cursor/Windsurf chat with Cmd+V — Claude will see the image.`
  );
}

async function copyMacOS(filePath: string, contentType: string): Promise<void> {
  // Use osascript to set clipboard to image data — works with PNG, JPEG, GIF, TIFF
  const typeMap: Record<string, string> = {
    "image/png": "«class PNGf»",
    "image/jpeg": "JPEG picture",
    "image/jpg": "JPEG picture",
    "image/gif": "GIF picture",
    "image/tiff": "TIFF picture",
    "image/webp": "«class PNGf»", // webp → treat as PNG after conversion isn't trivial; fallback
  };
  const appleType = typeMap[contentType] ?? "«class PNGf»";

  const script = `set the clipboard to (read (POSIX file "${filePath}") as ${appleType})`;
  await execFileAsync("osascript", ["-e", script]);
}

async function copyWindows(filePath: string): Promise<void> {
  // PowerShell: load image and set clipboard
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
$img = [System.Drawing.Image]::FromFile('${filePath.replace(/\\/g, "\\\\")}')
[System.Windows.Forms.Clipboard]::SetImage($img)
$img.Dispose()
  `.trim();
  await execFileAsync("powershell", ["-Command", ps]);
}

async function copyLinux(filePath: string): Promise<void> {
  // Try xclip first, then wl-clipboard (Wayland)
  try {
    await execFileAsync("xclip", ["-selection", "clipboard", "-t", "image/png", "-i", filePath]);
  } catch {
    // wl-copy for Wayland
    await execFileAsync("wl-copy", ["--type", "image/png"], {
      // pipe file content via stdin
    });
  }
}

function guessExt(contentType: string): string {
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/tiff": ".tiff",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
  };
  return map[contentType] ?? ".png";
}

/**
 * Pick one image from a list of attachments and copy to clipboard.
 */
export async function pickAndCopyImage(attachments: Attachment[]): Promise<void> {
  const images = attachments.filter(isImageAttachment);
  if (images.length === 0) {
    vscode.window.showInformationMessage("This issue has no image attachments.");
    return;
  }

  if (images.length === 1) {
    await copyImageToClipboard(images[0]);
    return;
  }

  const pick = await vscode.window.showQuickPick(
    images.map((a) => ({
      label: a.filename,
      description: `${Math.round(a.filesize / 1024)} KB`,
      attachment: a,
    })),
    { title: "Select image to copy to clipboard" }
  );
  if (!pick) return;
  await copyImageToClipboard(pick.attachment);
}
