package com.singam.ai;

import android.app.Activity;
import android.os.Bundle;
import android.content.Intent;
import android.net.Uri;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

public class MainActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(40, 60, 40, 40);

        TextView title = new TextView(this);
        title.setText("🦁 SINGAM AI");
        title.setTextSize(30);

        Button youtube = new Button(this);
        youtube.setText("Open YouTube");

        youtube.setOnClickListener(v -> {
            Intent intent = new Intent(
                Intent.ACTION_VIEW,
                Uri.parse("https://www.youtube.com/")
            );
            startActivity(intent);
        });

        layout.addView(title);
        layout.addView(youtube);

        setContentView(layout);
    }
}
