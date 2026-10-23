package io.github.bpmdata.palimpsest;

import android.content.ContentResolver;
import android.content.Intent;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;

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
 */
@CapacitorPlugin(name = "Library")
public class LibraryPlugin extends Plugin {

    private static final int KEEP_IN_CACHE = 3;   // copies of recently opened books kept by copyToCache

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
}
