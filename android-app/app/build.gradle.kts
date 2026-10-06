plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Native code (Runtime, DSLink tools, gateway, JNI, melonDS core) is built by scripts/build_android_native.sh into src/main/jniLibs/<abi>/.
// Gradle only packages it. The web UI + the frozen touch controls are copied from the repository (single source of truth) into the APK assets.
android {
    namespace = "com.dslink.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.dslink.app"
        minSdk = 26            // AAudio
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0-android-runtime"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        ndk { abiFilters += (project.findProperty("dslink.abis") as String? ?: "arm64-v8a").split(",") }
    }

    buildTypes {
        debug { isDebuggable = true }
        release { isMinifyEnabled = false }
    }

    packaging {
        // the Runtime, the DSLink tools and the gateway are executables shipped as lib*.so: they must be extracted to disk (nativeLibraryDir) to be run
        jniLibs { useLegacyPackaging = true }
    }

    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/webassets"))
    buildFeatures { buildConfig = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    lint { abortOnError = false }
}

val webAssets = tasks.register<Sync>("copyWebAssets") {
    into(layout.buildDirectory.dir("generated/webassets"))
    from("../../cloud/web/mp") { into("web/mp") }
    from("../../cloud/web/guest") { into("web/guest") }   // the iPhone's guest page assets (manifest, icons); the page itself is mp/index.html
    from("../../cloud/worker/public/controls") { into("controls") }
}
tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Assets") }.configureEach { dependsOn(webAssets) }

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.2")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")   // the Android framework JSON is not available in plain JVM unit tests
    androidTestImplementation("androidx.test:core:1.6.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:rules:1.6.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
}
