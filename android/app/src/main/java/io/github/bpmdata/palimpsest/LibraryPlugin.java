package io.github.bpmdata.palimpsest;

import android.content.ContentResolver;
import android.content.Intent;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * The library folder, through Android's own folder picker (the Storage Access Framework).
 * The reader picks one folder; the app keeps read permission to that folder only, across restarts.
 * No "All files access": Google Play doesn't allow it for reader apps, and it isn't needed.
 *
 * Methods (called from www/js/source.js):
 *   pickFolder()                 -> { treeUri, docId, name }
 *   hasAccess({ treeUri })       -> { ok }  (false if the folder was deleted or permission was taken back)
 *   list({ treeUri, docId })     -> { items: [{ docId, name, dir, size, modified, uri }] }
 *   copyToCache({ uri })         -> { path }  (fallback when the web view can't stream the file directly)
 *
 * Saving a copy ("Save as CBZ"), through Android's own "Save as" screen (ACTION_CREATE_DOCUMENT).
 * The app gets permission to write only the one new file the reader names there; the library folder stays read-only.
 * Android never overwrites a file this way (it adds " (1)" to the name instead).
 *   saveStart({ name, mime, treeUri?, docId? }) -> { id, name }   (rejects "cancelled" if the reader backs out)
 *   saveChunk({ id, data })      data: base64; pieces arrive in order
 *   saveFinish({ id })           -> { name, uri }
 *   saveAbort({ id })            deletes the half-written file
 */
@CapacitorPlugin(name = "Library")
public class LibraryPlugin extends Plugin {

    private static final int KEEP_IN_CACHE = 3;   // copies of recently opened books kept by copyToCache

    private static class Save { Uri uri; OutputStream out; }
    private final Map<String, Save> saves = new HashMap<>();

    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "folderPicked");
    }

    @ActivityCallback
    private void folderPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (data == null || data.getData() == null) {
            call.reject("cancelled");
            return;
        }
        Uri tree = data.getData();
        ContentResolver cr = getContext().getContentResolver();
        try {
            cr.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (SecurityException e) {
            call.reject("Android didn't allow Palimpsest to keep reading that folder.", e);
            return;
        }
        String docId = DocumentsContract.getTreeDocumentId(tree);
        String name = docId;
        Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, docId);
        try (Cursor c = cr.query(doc, new String[] { Document.COLUMN_DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst() && c.getString(0) != null) name = c.getString(0);
        } catch (Exception ignored) {}
        JSObject ret = new JSObject();
        ret.put("treeUri", tree.toString());
        ret.put("docId", docId);
        ret.put("name", name);
        call.resolve(ret);
    }

    @PluginMethod
    public void hasAccess(PluginCall call) {
        String treeUri = call.getString("treeUri", "");
        boolean ok = false;
        for (UriPermission p : getContext().getContentResolver().getPersistedUriPermissions()) {
            if (p.isReadPermission() && p.getUri().toString().equals(treeUri)) { ok = true; break; }
        }
        if (ok) {   // still there?
            Uri tree = Uri.parse(treeUri);
            Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
            try (Cursor c = getContext().getContentResolver().query(doc, new String[] { Document.COLUMN_DOCUMENT_ID }, null, null, null)) {
                ok = c != null && c.moveToFirst();
            } catch (Exception e) {
                ok = false;
            }
        }
        JSObject ret = new JSObject();
        ret.put("ok", ok);
        call.resolve(ret);
    }

    /** One query per folder (much faster than DocumentFile.listFiles on big collections). */
    @PluginMethod
    public void list(PluginCall call) {
        String treeUri = call.getString("treeUri"), docId = call.getString("docId");
        if (treeUri == null || docId == null) { call.reject("treeUri and docId are needed"); return; }
        Uri tree = Uri.parse(treeUri);
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId);
        String[] cols = { Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE,
            Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED };
        JSArray items = new JSArray();
        try (Cursor c = getContext().getContentResolver().query(children, cols, null, null, null)) {
            while (c != null && c.moveToNext()) {
                String id = c.getString(0), name = c.getString(1), mime = c.getString(2);
                if (id == null || name == null) continue;
                JSObject it = new JSObject();
                it.put("docId", id);
                it.put("name", name);
                it.put("dir", Document.MIME_TYPE_DIR.equals(mime));
                it.put("size", c.isNull(3) ? 0 : c.getLong(3));
                it.put("modified", c.isNull(4) ? 0 : c.getLong(4));
                it.put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, id).toString());
                items.put(it);
            }
        } catch (Exception e) {
            call.reject("Could not read the folder: " + e.getMessage(), e);
            return;
        }
        JSObject ret = new JSObject();
        ret.put("items", items);
        call.resolve(ret);
    }

    @PluginMethod
    public void copyToCache(PluginCall call) {
        String uri = call.getString("uri");
        if (uri == null) { call.reject("uri is needed"); return; }
        File dir = new File(getContext().getCacheDir(), "books");
        if (!dir.exists() && !dir.mkdirs()) { call.reject("No room in the app's cache"); return; }
        File out = new File(dir, Integer.toHexString(uri.hashCode()) + ".book");
        try (InputStream in = getContext().getContentResolver().openInputStream(Uri.parse(uri));
             OutputStream os = new FileOutputStream(out)) {
            if (in == null) throw new Exception("the file could not be opened");
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
        } catch (Exception e) {
            out.delete();
            call.reject("Could not read the file: " + e.getMessage(), e);
            return;
        }
        out.setLastModified(System.currentTimeMillis());
        File[] old = dir.listFiles();
        if (old != null && old.length > KEEP_IN_CACHE) {
            Arrays.sort(old, Comparator.comparingLong(File::lastModified).reversed());
            for (int i = KEEP_IN_CACHE; i < old.length; i++) old[i].delete();
        }
        JSObject ret = new JSObject();
        ret.put("path", out.getAbsolutePath());
        call.resolve(ret);
    }

    /* ---------- Save as ---------- */

    @PluginMethod
    public void saveStart(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(call.getString("mime", "application/octet-stream"));
        intent.putExtra(Intent.EXTRA_TITLE, call.getString("name", "Comic.cbz"));
        String treeUri = call.getString("treeUri"), docId = call.getString("docId");
        if (treeUri != null && docId != null) {   // open the screen in the folder being browsed
            intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, DocumentsContract.buildDocumentUriUsingTree(Uri.parse(treeUri), docId));
        }
        startActivityForResult(call, intent, "savePicked");
    }

    @ActivityCallback
    private void savePicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (data == null || data.getData() == null) { call.reject("cancelled"); return; }
        Uri uri = data.getData();
        ContentResolver cr = getContext().getContentResolver();
        Save save = new Save();
        save.uri = uri;
        try {
            save.out = cr.openOutputStream(uri, "wt");
            if (save.out == null) throw new Exception("no stream");
        } catch (Exception e) {
            deleteQuietly(uri);
            call.reject("Android didn't let Palimpsest write that file.", e);
            return;
        }
        String id = UUID.randomUUID().toString(), name = call.getString("name", "");
        try (Cursor c = cr.query(uri, new String[] { Document.COLUMN_DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst() && c.getString(0) != null) name = c.getString(0);
        } catch (Exception ignored) {}
        synchronized (saves) { saves.put(id, save); }
        JSObject ret = new JSObject();
        ret.put("id", id);
        ret.put("name", name);
        call.resolve(ret);
    }

    @PluginMethod
    public void saveChunk(PluginCall call) {
        Save save;
        synchronized (saves) { save = saves.get(call.getString("id", "")); }
        if (save == null) { call.reject("That save was already finished or stopped."); return; }
        try {
            save.out.write(Base64.decode(call.getString("data", ""), Base64.DEFAULT));
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not write the file: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void saveFinish(PluginCall call) {
        Save save;
        synchronized (saves) { save = saves.remove(call.getString("id", "")); }
        if (save == null) { call.reject("That save was already finished or stopped."); return; }
        try {
            save.out.close();
        } catch (Exception e) {
            deleteQuietly(save.uri);
            call.reject("Could not finish the file: " + e.getMessage(), e);
            return;
        }
        String name = null;
        try (Cursor c = getContext().getContentResolver().query(save.uri, new String[] { Document.COLUMN_DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) name = c.getString(0);
        } catch (Exception ignored) {}
        JSObject ret = new JSObject();
        if (name != null) ret.put("name", name);
        ret.put("uri", save.uri.toString());
        call.resolve(ret);
    }

    @PluginMethod
    public void saveAbort(PluginCall call) {
        Save save;
        synchronized (saves) { save = saves.remove(call.getString("id", "")); }
        if (save != null) {
            try { save.out.close(); } catch (Exception ignored) {}
            deleteQuietly(save.uri);
        }
        call.resolve();
    }

    private void deleteQuietly(Uri uri) {
        try { DocumentsContract.deleteDocument(getContext().getContentResolver(), uri); } catch (Exception ignored) {}
    }
}
