package io.github.bpmdata.palimpsest;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LibraryPlugin.class);   // the library folder (see LibraryPlugin.java)
        super.onCreate(savedInstanceState);
    }
}
