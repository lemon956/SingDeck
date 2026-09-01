package io.singdeck.app.ui.widget;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Shader;
import android.util.AttributeSet;
import android.view.View;

import androidx.annotation.Nullable;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public class SpeedWaveformView extends View {
    private static final int SAMPLE_COUNT = 20;

    private final List<Double> downHistory = new ArrayList<>(Collections.nCopies(SAMPLE_COUNT, 0.0));
    private final List<Double> upHistory = new ArrayList<>(Collections.nCopies(SAMPLE_COUNT, 0.0));

    private final Paint downLinePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint downFillPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint upLinePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint upFillPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint gridPaint = new Paint(Paint.ANTI_ALIAS_FLAG);

    private final Path downPath = new Path();
    private final Path upPath = new Path();

    public SpeedWaveformView(Context context) {
        super(context);
        init();
    }

    public SpeedWaveformView(Context context, @Nullable AttributeSet attrs) {
        super(context, attrs);
        init();
    }

    public SpeedWaveformView(Context context, @Nullable AttributeSet attrs, int defStyleAttr) {
        super(context, attrs, defStyleAttr);
        init();
    }

    private void init() {
        downLinePaint.setColor(0xFF38BDF8); // Cyan
        downLinePaint.setStrokeWidth(3.5f);
        downLinePaint.setStyle(Paint.Style.STROKE);

        downFillPaint.setStyle(Paint.Style.FILL);

        upLinePaint.setColor(0xFF22C55E); // Green
        upLinePaint.setStrokeWidth(2.5f);
        upLinePaint.setStyle(Paint.Style.STROKE);

        upFillPaint.setStyle(Paint.Style.FILL);

        gridPaint.setColor(0x15FFFFFF);
        gridPaint.setStrokeWidth(1.5f);
        gridPaint.setStyle(Paint.Style.STROKE);
    }

    public void addSample(double downKbps, double upKbps) {
        downHistory.remove(0);
        downHistory.add(downKbps);

        upHistory.remove(0);
        upHistory.add(upKbps);

        invalidate();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);

        int width = getWidth();
        int height = getHeight();
        if (width <= 0 || height <= 0) return;

        // Draw horizontal grid lines
        canvas.drawLine(0, height * 0.33f, width, height * 0.33f, gridPaint);
        canvas.drawLine(0, height * 0.66f, width, height * 0.66f, gridPaint);

        double maxVal = 10.0;
        for (double v : downHistory) if (v > maxVal) maxVal = v;
        for (double v : upHistory) if (v > maxVal) maxVal = v;

        // Setup Gradient Shaders
        downFillPaint.setShader(new LinearGradient(
                0, 0, 0, height,
                0x5038BDF8, 0x0038BDF8,
                Shader.TileMode.CLAMP
        ));

        upFillPaint.setShader(new LinearGradient(
                0, 0, 0, height,
                0x3522C55E, 0x0022C55E,
                Shader.TileMode.CLAMP
        ));

        // Draw Download Waveform
        drawWaveform(canvas, downHistory, maxVal, width, height, downLinePaint, downFillPaint, downPath);

        // Draw Upload Waveform
        drawWaveform(canvas, upHistory, maxVal, width, height, upLinePaint, upFillPaint, upPath);
    }

    private void drawWaveform(Canvas canvas, List<Double> data, double maxVal, int width, int height,
                              Paint linePaint, Paint fillPaint, Path path) {
        path.reset();
        float stepX = (float) width / (SAMPLE_COUNT - 1);

        float prevX = 0;
        float prevY = (float) (height - (data.get(0) / maxVal) * (height - 12));
        path.moveTo(prevX, prevY);

        for (int i = 1; i < SAMPLE_COUNT; i++) {
            float x = i * stepX;
            float y = (float) (height - (data.get(i) / maxVal) * (height - 12));
            float midX = (prevX + x) / 2;
            path.cubicTo(midX, prevY, midX, y, x, y);
            prevX = x;
            prevY = y;
        }

        // Stroke line
        canvas.drawPath(path, linePaint);

        // Fill under curve
        path.lineTo(width, height);
        path.lineTo(0, height);
        path.close();
        canvas.drawPath(path, fillPaint);
    }
}
