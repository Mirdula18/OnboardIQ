/**
 * @fileoverview Saves HR email attachments to a per-hire Drive folder and loads them back for dispatch.
 */

/** Images smaller than this are treated as signature/inline images and skipped. */
const MIN_IMAGE_BYTES = 10 * 1024;

/**
 * Saves the message's attachments to 'Onboarding Access Bot/<EmployeeID>_<Name>/'.
 * Reuses the hire's existing folder if drive_folder_url is already set.
 * @param {GoogleAppsScript.Gmail.GmailMessage} msg HR email.
 * @param {Object} hire hire row.
 * @return {{folderUrl: string, folderId: string, fileIds: Array<string>, names: Array<string>}} result.
 */
function saveAttachments(msg, hire) {
  const files = msg.getAttachments({ includeInlineImages: true, includeAttachments: true })
    .filter((a) => !(/^image\//i.test(a.getContentType()) && a.getSize() < MIN_IMAGE_BYTES));
  const folder = getOrCreateHireFolder(hire);
  const existing = listFolderFileNames(folder);
  const fileIds = [];
  const names = [];
  files.forEach((a) => {
    const name = a.getName() || 'attachment';
    if (existing.indexOf(name) >= 0) return; // same file already saved (re-sent email)
    const file = folder.createFile(a.copyBlob().setName(name));
    fileIds.push(file.getId());
    names.push(name);
  });
  return { folderUrl: folder.getUrl(), folderId: folder.getId(), fileIds, names };
}

/**
 * Gets the hire's Drive folder (from drive_folder_url) or creates it under the root folder.
 * @param {Object} hire hire row.
 * @return {GoogleAppsScript.Drive.Folder} folder.
 */
function getOrCreateHireFolder(hire) {
  const existingId = folderIdFromUrl(hire.drive_folder_url);
  if (existingId) {
    try {
      return DriveApp.getFolderById(existingId);
    } catch (e) {
      logEvent('WARN', 'FOLDER_MISSING', `Recreating folder for ${hire.hire_no}`, hire.hire_no);
    }
  }
  const root = getRootFolder();
  const name = `${hire.employee_id || 'NOID'}_${hire.full_name || hire.hire_no}`.replace(/[\\/:*?"<>|]/g, '_');
  const it = root.getFoldersByName(name);
  return it.hasNext() ? it.next() : root.createFolder(name);
}

/**
 * The root 'Onboarding Access Bot' folder (ROOT_FOLDER_ID script property).
 * @return {GoogleAppsScript.Drive.Folder} folder.
 */
function getRootFolder() {
  const id = getScriptProp(PROP_KEYS.ROOT_FOLDER_ID);
  if (!id) throw new Error('ROOT_FOLDER_ID not set — run setup()');
  return DriveApp.getFolderById(id);
}

/**
 * Loads all files in the hire's folder as blobs (for teams with send_attachments = TRUE).
 * @param {Object} hire hire row.
 * @return {Array<GoogleAppsScript.Base.Blob>} blobs.
 */
function getHireAttachmentBlobs(hire) {
  const id = folderIdFromUrl(hire.drive_folder_url);
  if (!id) return [];
  const blobs = [];
  const it = DriveApp.getFolderById(id).getFiles();
  while (it.hasNext()) blobs.push(it.next().getBlob());
  return blobs;
}

/**
 * File names in a folder.
 * @param {GoogleAppsScript.Drive.Folder} folder folder.
 * @return {Array<string>} names.
 */
function listFolderFileNames(folder) {
  const names = [];
  const it = folder.getFiles();
  while (it.hasNext()) names.push(it.next().getName());
  return names;
}

/**
 * Extracts a folder id from a Drive folder URL.
 * @param {string} url e.g. https://drive.google.com/drive/folders/<id>.
 * @return {string} id or ''.
 */
function folderIdFromUrl(url) {
  const m = /folders\/([A-Za-z0-9_-]+)/.exec(String(url || ''));
  return m ? m[1] : '';
}
