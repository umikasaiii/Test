package com.dslink.emulator;

import android.app.Activity;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/** Minimal dark UI toolkit (no XML, no external libraries). */
final class Ui {
    private Ui() {}

    static final int BG = Color.parseColor("#0F1115");
    static final int CARD = Color.parseColor("#1A1D24");
    static final int ACCENT = Color.parseColor("#4F8CFF");
    static final int TEXT = Color.parseColor("#F2F4F8");
    static final int MUTED = Color.parseColor("#9AA3B2");
    static final int OK = Color.parseColor("#3DDC84");
    static final int WARN = Color.parseColor("#FFB020");
    static final int ERR = Color.parseColor("#FF5C5C");

    static int dp(Context c, int v) {
        return Math.round(v * c.getResources().getDisplayMetrics().density);
    }

    /** Vertical scrolling page with a title. Returns the content column. */
    static LinearLayout page(Activity a, String title, String subtitle) {
        ScrollView sv = new ScrollView(a);
        sv.setBackgroundColor(BG);
        sv.setFillViewport(true);
        LinearLayout col = new LinearLayout(a);
        col.setOrientation(LinearLayout.VERTICAL);
        int p = dp(a, 20);
        col.setPadding(p, dp(a, 36), p, p);
        sv.addView(col, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        a.setContentView(sv);
        col.addView(text(a, title, 34, TEXT, true));
        if (subtitle != null) col.addView(text(a, subtitle, 15, MUTED, false));
        col.addView(space(a, 20));
        return col;
    }

    static TextView text(Context c, String s, int sp, int color, boolean bold) {
        TextView t = new TextView(c);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    static View space(Context c, int dp) {
        View v = new View(c);
        v.setLayoutParams(new LinearLayout.LayoutParams(1, dp(c, dp)));
        return v;
    }

    static TextView section(Context c, String s) {
        TextView t = text(c, s.toUpperCase(), 12, MUTED, true);
        t.setPadding(0, dp(c, 22), 0, dp(c, 8));
        t.setLetterSpacing(0.1f);
        return t;
    }

    static Button button(Context c, String label, boolean primary, View.OnClickListener l) {
        Button b = new Button(c);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(17);
        b.setTextColor(primary ? Color.WHITE : TEXT);
        GradientDrawable d = new GradientDrawable();
        d.setCornerRadius(dp(c, 16));
        d.setColor(primary ? ACCENT : CARD);
        b.setBackground(d);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(c, 58));
        lp.bottomMargin = dp(c, 12);
        b.setLayoutParams(lp);
        b.setOnClickListener(l);
        return b;
    }

    static LinearLayout card(Context c) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable d = new GradientDrawable();
        d.setCornerRadius(dp(c, 18));
        d.setColor(CARD);
        l.setBackground(d);
        int p = dp(c, 18);
        l.setPadding(p, p, p, p);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = dp(c, 12);
        l.setLayoutParams(lp);
        l.setGravity(Gravity.START);
        return l;
    }
}
