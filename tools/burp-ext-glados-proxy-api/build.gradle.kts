// Gradle build for the GLaDOS Burp Montoya extension.
// Produces a fat JAR in build/libs/ that you load via Burp → Extensions →
// Installed → Add → Extension type: Java → Select file.
//
// Build:  ./gradlew shadowJar
// Output: build/libs/glados-proxy-api-1.0.0-all.jar

plugins {
    kotlin("jvm") version "1.9.22"
    id("com.github.johnrengelman.shadow") version "8.1.1"
}

group = "glados"
version = "1.0.0"

repositories {
    mavenCentral()
}

dependencies {
    // Burp Montoya API — provided by Burp at runtime, but needed at compile time.
    compileOnly("net.portswigger.burp.extensions:montoya-api:2023.12.1")

    // Embedded HTTP server. NanoHTTPD is small, single-JAR, no deps — ideal for
    // an in-process server exposing /proxy/history and /proxy/stream.
    implementation("org.nanohttpd:nanohttpd:2.3.1")

    // JSON serialization.
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin:2.17.0")
    implementation("com.fasterxml.jackson.core:jackson-databind:2.17.0")

    implementation(kotlin("stdlib"))
}

kotlin {
    jvmToolchain(17)
}

tasks.shadowJar {
    archiveClassifier.set("all")
    mergeServiceFiles()
    // Burp loads the extension via a BurpExtension service entry declared in
    // resources/META-INF/services/burp.api.montoya.BurpExtension
}

tasks.build { dependsOn(tasks.shadowJar) }
